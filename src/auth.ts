import {
  AppError,
  requireAuthPepper,
  arrayBuffer,
  asInt,
  asText,
  base64UrlToBytes,
  base64Url,
  clearSessionCookie,
  cookieMap,
  encoder,
  Env,
  json,
  now,
  randomToken,
  readJson,
  requestIpHash,
  requireOrigin,
  SESSION_COOKIE_NAME,
  sessionCookie,
  sha256,
  timingSafeEqual,
  userAgentHash,
  uuid,
  validEmail,
  normalizeEmail,
  type Row,
} from "./lib.js";

const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_IP_LIMIT = 12;
const LOGIN_EMAIL_LIMIT = 8;
const MAX_ACTIVE_SESSIONS = 5;
export interface SessionUser {
  adminId: string;
  email: string;
  csrfToken: string;
  sessionId: string;
}

function passwordIterations(env: Env): number {
  // Cloudflare production workerd caps PBKDF2 iterations at 100,000
  // (github.com/cloudflare/workerd#1346); values above it throw
  // NotSupportedError. The Workers Free plan also limits CPU time to 10ms
  // per request, which fits ~8,000 iterations of PBKDF2-SHA-256 locally
  // measured in workerd (~4ms), leaving headroom for the rest of the
  // request (and for the two digests in change-password). Default 8,000.
  return asInt(env.PASSWORD_ITERATIONS, 8_000, 8_000, 100_000);
}

function sessionHours(env: Env): number {
  return asInt(env.SESSION_HOURS, 12, 1, 72);
}

// Idle expiry is a second, independent bound on session life: an unattended
// session is revoked after this many minutes without a request. 0 disables
// idle expiry (the absolute SESSION_HOURS bound still applies).
function sessionIdleMinutes(env: Env): number {
  return asInt(env.SESSION_IDLE_MINUTES, 60, 0, sessionHours(env) * 60);
}

export const PASSWORD_SCHEME_V1 = "pbkdf2-sha256+hmac-sha256-v1";

export function normalizePassword(password: string): string {
  return password.normalize("NFC");
}

export async function passwordDigest(password: string, salt: Uint8Array, iterations: number, env: Env): Promise<string> {
  const pepper = requireAuthPepper(env);
  const material = await crypto.subtle.importKey("raw", encoder.encode(normalizePassword(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: arrayBuffer(salt), iterations },
    material,
    256,
  );
  const key = new Uint8Array(bits);
  const pepperKey = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const final = new Uint8Array(await crypto.subtle.sign("HMAC", pepperKey, arrayBuffer(key)));
  return base64Url(final);
}

export async function legacyPasswordDigest(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(normalizePassword(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: arrayBuffer(salt), iterations },
    material,
    256,
  );
  return base64Url(new Uint8Array(bits));
}

function validatePassword(password: string): void {
  const normalized = normalizePassword(password);
  const codePoints = Array.from(normalized).length;
  if (codePoints === 0) {
    throw new AppError(400, "Password must be non-empty.", "invalid_password");
  }
  if (codePoints < 15) {
    throw new AppError(400, "Password must be at least 15 characters.", "invalid_password");
  }
  if (codePoints > 128) {
    throw new AppError(400, "Password must be 128 characters or fewer and is rejected, not truncated.", "password_too_long");
  }
  if (encoder.encode(normalized).byteLength > 512) {
    throw new AppError(400, "Password exceeds the maximum supported byte length.", "password_too_long");
  }
}

function boundedPassword(value: unknown): string {
  if (typeof value !== "string") throw new AppError(400, "Password must be text.", "invalid_password");
  const normalized = normalizePassword(value);
  const codePoints = Array.from(normalized).length;
  if (codePoints > 128) {
    throw new AppError(400, "Password must be 128 characters or fewer and is rejected, not truncated.", "password_too_long");
  }
  if (encoder.encode(normalized).byteLength > 512) {
    throw new AppError(400, "Password exceeds the maximum supported byte length.", "password_too_long");
  }
  return normalized;
}

function adminUsesV1Scheme(admin: Row): boolean {
  return String(admin.password_scheme || "") === PASSWORD_SCHEME_V1;
}

async function upgradePasswordHash(password: string, admin: Row, env: Env): Promise<void> {
  const targetIterations = passwordIterations(env);
  const needsIterationsUpgrade = Number(admin.password_iterations || 0) < targetIterations;
  const needsSchemeUpgrade = !adminUsesV1Scheme(admin);
  if (!needsIterationsUpgrade && !needsSchemeUpgrade) return;
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await passwordDigest(password, salt, targetIterations, env);
  await env.DB.prepare(
    `UPDATE admins
        SET password_hash=?,password_salt=?,password_iterations=?,password_scheme=?,updated_at=?
      WHERE admin_id=? AND password_hash=?`,
  ).bind(hash, base64Url(salt), targetIterations, PASSWORD_SCHEME_V1, now(), admin.admin_id, admin.password_hash).run();
}

async function initialized(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM admins LIMIT 1").first<Row>();
  return Boolean(row?.ok);
}

async function subjectHash(scope: "ip" | "email", value: string, env: Env): Promise<string> {
  return sha256(`${requireAuthPepper(env)}|${scope}|${value}`);
}

async function recordAttempt(env: Env, scope: "ip" | "email", hash: string, success: boolean): Promise<void> {
  await env.DB.prepare("INSERT INTO auth_attempts(attempt_id,scope,subject_hash,success,created_at) VALUES(?,?,?,?,?)")
    .bind(uuid(), scope, hash, success ? 1 : 0, now()).run();
}

async function enforceLoginRateLimit(env: Env, ipHash: string, emailHash: string): Promise<void> {
  const cutoff = new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60_000).toISOString();
  const [ip, email] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM auth_attempts WHERE scope='ip' AND subject_hash=? AND success=0 AND created_at>=?")
      .bind(ipHash, cutoff).first<Row>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM auth_attempts WHERE scope='email' AND subject_hash=? AND success=0 AND created_at>=?")
      .bind(emailHash, cutoff).first<Row>(),
  ]);
  if (Number(ip?.count || 0) >= LOGIN_IP_LIMIT || Number(email?.count || 0) >= LOGIN_EMAIL_LIMIT) {
    throw new AppError(429, "Too many login attempts. Try again later.", "rate_limited");
  }
}

async function trimSessions(env: Env, adminId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE admin_sessions
        SET revoked_at=?
      WHERE admin_id=? AND revoked_at IS NULL AND session_id NOT IN (
        SELECT session_id FROM admin_sessions
         WHERE admin_id=? AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT ?
      )`,
  ).bind(now(), adminId, adminId, MAX_ACTIVE_SESSIONS).run();
}

async function createSession(request: Request, env: Env, admin: Row): Promise<Response> {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const csrfToken = randomToken(24);
  const sessionId = uuid();
  const createdAt = now();
  const maxAge = sessionHours(env) * 60 * 60;
  const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
  const [ipHash, uaHash] = await Promise.all([requestIpHash(request, env), userAgentHash(request, env)]);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO admin_sessions(session_id,admin_id,token_hash,csrf_token,ip_hash,user_agent_hash,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(sessionId, admin.admin_id, tokenHash, csrfToken, ipHash, uaHash, createdAt, createdAt, expiresAt),
    env.DB.prepare("UPDATE admins SET last_login_at=?,updated_at=? WHERE admin_id=?")
      .bind(createdAt, createdAt, admin.admin_id),
  ]);
  await trimSessions(env, String(admin.admin_id));
  return json(
    { authenticated: true, email: admin.email, csrf_token: csrfToken },
    200,
    { "Set-Cookie": sessionCookie(token, maxAge) },
  );
}

async function revokeSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare("UPDATE admin_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE session_id=?")
    .bind(now(), sessionId).run();
}

export async function getSession(request: Request, env: Env): Promise<SessionUser | null> {
  const token = cookieMap(request).get(SESSION_COOKIE_NAME);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT s.session_id,s.csrf_token,s.expires_at,s.last_seen_at,s.ip_hash,s.user_agent_hash,
            a.admin_id,a.email,a.disabled
       FROM admin_sessions s JOIN admins a ON a.admin_id=s.admin_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL LIMIT 1`,
  ).bind(tokenHash).first<Row>();
  if (!row || Number(row.disabled || 0) === 1 || String(row.expires_at || "") <= now()) {
    if (row?.session_id) await revokeSession(env, String(row.session_id));
    return null;
  }

  const uaHash = await userAgentHash(request, env);
  if (row.user_agent_hash && !timingSafeEqual(String(row.user_agent_hash), uaHash)) {
    await revokeSession(env, String(row.session_id));
    return null;
  }

  const lastSeen = Date.parse(String(row.last_seen_at || ""));
  const idleLimitMs = sessionIdleMinutes(env) * 60_000;
  if (idleLimitMs > 0 && Number.isFinite(lastSeen) && Date.now() - lastSeen > idleLimitMs) {
    await revokeSession(env, String(row.session_id));
    return null;
  }
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 5 * 60_000) {
    await env.DB.prepare("UPDATE admin_sessions SET last_seen_at=? WHERE session_id=?").bind(now(), row.session_id).run();
  }
  return {
    adminId: String(row.admin_id),
    email: String(row.email),
    csrfToken: String(row.csrf_token),
    sessionId: String(row.session_id),
  };
}

export async function requireSession(request: Request, env: Env, csrf = false): Promise<SessionUser> {
  const session = await getSession(request, env);
  if (!session) throw new AppError(401, "Sign in to continue.", "unauthorized");
  if (csrf) {
    requireOrigin(request, env);
    const token = request.headers.get("X-CSRF-Token") || "";
    if (!token || !timingSafeEqual(token, session.csrfToken)) {
      throw new AppError(403, "Security token is invalid. Refresh and try again.", "csrf_invalid");
    }
  }
  return session;
}

export async function authStatus(request: Request, env: Env): Promise<Response> {
  const ready = await initialized(env);
  const session = ready ? await getSession(request, env) : null;
  return json({
    initialized: ready,
    authenticated: Boolean(session),
    email: session?.email || null,
    csrf_token: session?.csrfToken || null,
  });
}

export async function bootstrap(request: Request, env: Env): Promise<Response> {
  requireOrigin(request, env);
  if (await initialized(env)) throw new AppError(409, "Mailbox administrator is already initialized.", "already_initialized");
  const expected = env.ADMIN_BOOTSTRAP_TOKEN || "";
  const supplied = request.headers.get("X-Bootstrap-Token") || "";
  if (!expected || !supplied || !timingSafeEqual(expected, supplied)) {
    throw new AppError(403, "Bootstrap token is invalid.", "bootstrap_denied");
  }
  if (!env.AUTH_PEPPER || env.AUTH_PEPPER.length < 32) {
    throw new AppError(503, "AUTH_PEPPER must be configured before setup.", "auth_not_configured");
  }
  const body = await readJson(request, 16 * 1024);
  const configuredEmail = normalizeEmail(env.ADMIN_EMAIL);
  const email = normalizeEmail(body.email || configuredEmail);
  const password = boundedPassword(body.password);
  if (!validEmail(email) || (configuredEmail && email !== configuredEmail)) {
    throw new AppError(400, "Administrator email does not match the configured address.", "invalid_admin_email");
  }
  validatePassword(password);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = passwordIterations(env);
  const hash = await passwordDigest(password, salt, iterations, env);
  const adminId = uuid();
  const timestamp = now();
  try {
    await env.DB.prepare("INSERT INTO admins(admin_id,email,password_hash,password_salt,password_iterations,password_scheme,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(adminId, email, hash, base64Url(salt), iterations, PASSWORD_SCHEME_V1, timestamp, timestamp).run();
  } catch {
    throw new AppError(409, "Mailbox administrator is already initialized.", "already_initialized");
  }
  return createSession(request, env, { admin_id: adminId, email });
}

export async function login(request: Request, env: Env): Promise<Response> {
  requireOrigin(request, env);
  if (!(await initialized(env))) throw new AppError(409, "Complete one-time mailbox setup first.", "not_initialized");
  const body = await readJson(request, 16 * 1024);
  const email = normalizeEmail(body.email);
  const password = boundedPassword(body.password);
  const ipHash = await requestIpHash(request, env);
  const emailHash = await subjectHash("email", email, env);
  await enforceLoginRateLimit(env, ipHash, emailHash);
  const admin = validEmail(email)
    ? await env.DB.prepare("SELECT * FROM admins WHERE email=? COLLATE NOCASE LIMIT 1").bind(email).first<Row>()
    : null;
  let valid = false;
  if (admin && Number(admin.disabled || 0) === 0) {
    const salt = base64UrlToBytes(String(admin.password_salt));
    const actual = adminUsesV1Scheme(admin)
      ? await passwordDigest(password, salt, Number(admin.password_iterations), env)
      : await legacyPasswordDigest(password, salt, Number(admin.password_iterations));
    valid = timingSafeEqual(actual, String(admin.password_hash));
  } else {
    const dummySalt = new Uint8Array(16);
    await passwordDigest(password || "invalid-password", dummySalt, passwordIterations(env), env);
  }
  await Promise.all([
    recordAttempt(env, "ip", ipHash, valid),
    recordAttempt(env, "email", emailHash, valid),
  ]);
  if (!valid || !admin) throw new AppError(401, "Email or password is incorrect.", "invalid_credentials");
  await upgradePasswordHash(password, admin, env);
  return createSession(request, env, admin);
}

export async function logout(request: Request, env: Env): Promise<Response> {
  requireOrigin(request, env);
  const session = await getSession(request, env);
  if (session) {
    const csrf = request.headers.get("X-CSRF-Token") || "";
    if (!csrf || !timingSafeEqual(csrf, session.csrfToken)) throw new AppError(403, "Security token is invalid.", "csrf_invalid");
    await revokeSession(env, session.sessionId);
  }
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

export async function logoutAll(request: Request, env: Env, session: SessionUser): Promise<Response> {
  await env.DB.prepare("UPDATE admin_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE admin_id=?")
    .bind(now(), session.adminId).run();
  await audit(request, env, session, "auth_logout_all", "admin", session.adminId);
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

export async function changePassword(request: Request, env: Env, session: SessionUser): Promise<Response> {
  const body = await readJson(request, 16 * 1024);
  const currentPassword = boundedPassword(body.current_password);
  const newPassword = boundedPassword(body.new_password);
  validatePassword(newPassword);
  if (timingSafeEqual(currentPassword, newPassword)) throw new AppError(400, "New password must be different.", "password_unchanged");

  const admin = await env.DB.prepare("SELECT * FROM admins WHERE admin_id=? AND disabled=0 LIMIT 1")
    .bind(session.adminId).first<Row>();
  if (!admin) throw new AppError(401, "Administrator account is unavailable.", "unauthorized");
  const currentHash = adminUsesV1Scheme(admin)
    ? await passwordDigest(currentPassword, base64UrlToBytes(String(admin.password_salt)), Number(admin.password_iterations), env)
    : await legacyPasswordDigest(currentPassword, base64UrlToBytes(String(admin.password_salt)), Number(admin.password_iterations));
  if (!timingSafeEqual(currentHash, String(admin.password_hash))) {
    throw new AppError(401, "Current password is incorrect.", "invalid_credentials");
  }

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = passwordIterations(env);
  const hash = await passwordDigest(newPassword, salt, iterations, env);
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE admins SET password_hash=?,password_salt=?,password_iterations=?,password_scheme=?,updated_at=? WHERE admin_id=?")
      .bind(hash, base64Url(salt), iterations, PASSWORD_SCHEME_V1, timestamp, session.adminId),
    env.DB.prepare("UPDATE admin_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE admin_id=?")
      .bind(timestamp, session.adminId),
  ]);
  await audit(request, env, session, "auth_password_changed", "admin", session.adminId);
  return json({ ok: true, reauthenticate: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

export async function audit(
  request: Request,
  env: Env,
  session: SessionUser | null,
  action: string,
  targetType?: string,
  targetId?: string,
  details?: unknown,
  requestId?: string,
): Promise<void> {
  const ipHash = await requestIpHash(request, env);
  const correlationId = requestId || request.headers.get("X-MailGable-Request-ID") || null;
  await env.DB.prepare("INSERT OR IGNORE INTO admin_audit_log(audit_id,admin_id,action,target_type,target_id,request_id,ip_hash,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(uuid(), session?.adminId || null, action, targetType || null, targetId || null, correlationId, ipHash, details ? JSON.stringify(details).slice(0, 100_000) : null, now()).run();
}

export async function cleanupAuth(env: Env): Promise<void> {
  const authCutoff = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
  const sessionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_attempts WHERE created_at<?").bind(authCutoff),
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<? OR (revoked_at IS NOT NULL AND revoked_at<?)").bind(now(), sessionCutoff),
  ]);
}
