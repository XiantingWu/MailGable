import { verifySvixSignature } from "../lib.js";

export async function verifyResendWebhook(raw: string, headers: Headers, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  return verifySvixSignature(raw, headers, secret, nowSeconds);
}