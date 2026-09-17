import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);

export async function loadMailModule() {
  const compiled = require.resolve("../../.test-build/src/mail.js");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "../lib.js" || request === "./lib.js") {
      return require("../../.test-build/src/lib.js");
    }
    if (request === "../auth.js" || request === "./auth.js") {
      return { audit: async () => undefined };
    }
    if (request === "postal-mime") {
      return { default: { parse: async () => ({}) } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(compiled);
  } finally {
    Module._load = originalLoad;
  }
}