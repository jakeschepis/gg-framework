import { describe, expect, it, vi } from "vitest";

import { killProcessTree, resolveWindowsTaskkillPath } from "./process.js";

describe("resolveWindowsTaskkillPath", () => {
  it("resolves taskkill from SystemRoot", () => {
    expect(resolveWindowsTaskkillPath({ SystemRoot: "C:\\Windows" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
  });

  it("is case-insensitive about the env var name and falls back to WINDIR", () => {
    expect(resolveWindowsTaskkillPath({ systemroot: "D:/Win" })).toBe(
      "D:\\Win\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({ WINDIR: "E:\\W" })).toBe("E:\\W\\System32\\taskkill.exe");
  });

  it("rejects relative or injected roots and falls back to C:\\Windows", () => {
    expect(resolveWindowsTaskkillPath({ SystemRoot: "windows" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({ SystemRoot: "C:\\Win;C:\\evil" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({})).toBe("C:\\Windows\\System32\\taskkill.exe");
  });
});

describe("killProcessTree", () => {
  it("kills the whole tree with taskkill on Windows (never a negative pid)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    const kill = vi.fn();

    killProcessTree(4242, {
      platform: "win32",
      kill,
      spawnSync: spawnSync as never,
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(spawnSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to the direct pid when taskkill fails", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1 });
    const kill = vi.fn();

    killProcessTree(7, { platform: "win32", kill, spawnSync: spawnSync as never, env: {} });

    expect(kill).toHaveBeenCalledWith(7, "SIGKILL");
  });

  it("signals the process group on POSIX", () => {
    const kill = vi.fn();
    killProcessTree(99, { platform: "darwin", kill });
    expect(kill).toHaveBeenCalledWith(-99, "SIGKILL");
  });
});
