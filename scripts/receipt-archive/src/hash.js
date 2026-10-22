import { createHash } from "node:crypto";

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
