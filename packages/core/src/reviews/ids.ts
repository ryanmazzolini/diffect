import { randomBytes } from "node:crypto";

/** Short, collision-resistant id with a type prefix, e.g. `th_8f2a1c`. */
export function genId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}
