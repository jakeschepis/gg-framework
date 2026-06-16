import { describe, expect, it } from "vitest";
import { platformClass } from "./platform";

describe("platformClass", () => {
  it("maps macOS identifiers", () => {
    expect(platformClass("macos")).toBe("platform-macos");
    expect(platformClass("darwin")).toBe("platform-macos");
    expect(platformClass("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)")).toBe("platform-macos");
  });

  it("maps Windows identifiers", () => {
    expect(platformClass("windows")).toBe("platform-windows");
    expect(platformClass("Win32")).toBe("platform-windows");
    expect(platformClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("platform-windows");
  });

  it("maps Linux identifiers", () => {
    expect(platformClass("linux")).toBe("platform-linux");
    expect(platformClass("Mozilla/5.0 (X11; Linux x86_64)")).toBe("platform-linux");
  });

  it("falls back to linux (native chrome) for unknown", () => {
    expect(platformClass("")).toBe("platform-linux");
    expect(platformClass("freebsd")).toBe("platform-linux");
  });
});
