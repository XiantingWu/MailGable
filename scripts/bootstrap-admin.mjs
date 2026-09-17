import readline from "node:readline";
import process from "node:process";

// One-time administrator bootstrap against a deployed Worker.
//
//   node scripts/bootstrap-admin.mjs <origin> <email>
//
// The bootstrap token and password are read from hidden stdin — never from
// argv (a secret on argv can leak through process listings/CI logs).
const [originArg, email] = process.argv.slice(2);
if (!originArg || !email) {
  console.error("Usage: node scripts/bootstrap-admin.mjs <origin> <email>   (token and password are prompted, hidden)");
  process.exit(2);
}

function hiddenInput(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    if (!process.stdin.isTTY) {
      const chunks = [];
      process.stdin.resume();
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
      return;
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    let value = "";
    const onKeypress = (str, key) => {
      if (key && key.ctrl && key.name === "c") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (key && (key.name === "return" || key.name === "enter")) {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.stdin.removeListener("keypress", onKeypress);
        resolve(value);
      } else if (key && key.name === "backspace") {
        value = value.slice(0, -1);
      } else if (str) {
        value += str;
      }
    };
    process.stdin.on("keypress", onKeypress);
  });
}

const token = await hiddenInput("Bootstrap token (hidden input): ");
if (!token) {
  console.error("No bootstrap token entered; aborted.");
  process.exit(2);
}
const password = await hiddenInput("Administrator password (hidden input): ");
if (!password) {
  console.error("No password entered; aborted.");
  process.exit(2);
}

const baseOrigin = new URL(originArg).origin;
const response = await fetch(`${baseOrigin}/api/admin/mail/auth/bootstrap`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Bootstrap-Token": token, Origin: baseOrigin },
  body: JSON.stringify({ email, password }),
});
const body = await response.text();
if (!response.ok) {
  console.error(`Bootstrap failed (${response.status}): ${body}`);
  process.exit(1);
}
console.log("Administrator initialized successfully.");
