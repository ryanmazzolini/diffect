import { describe, expect, it } from "vitest";
import { linuxProcStatIsExited } from "../src/daemon-manager.js";

describe("daemon manager process state", () => {
  it("treats a Linux zombie as exited", () => {
    expect(linuxProcStatIsExited("123 (diffectd) Z 1 2 3")).toBe(true);
    expect(linuxProcStatIsExited("123 (diffectd) S 1 2 3")).toBe(false);
    expect(linuxProcStatIsExited("123 (diffectd) R 1 2 3")).toBe(false);
  });
});
