import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

function isMain(importMetaUrl, argvEntry = process.argv[1]) {
  if (!argvEntry) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

export { isMain };
