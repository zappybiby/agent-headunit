import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function backendFile(filename) {
  const bundled = fileURLToPath(new URL(`../backend/${filename}`, import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL(`../../backend/${filename}`, import.meta.url));
}
