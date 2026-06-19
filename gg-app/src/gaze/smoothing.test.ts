import { describe, expect, it } from "vitest";
import { createDwellTracker, createPointSmoother } from "./smoothing";

describe("createPointSmoother", () => {
  it("returns the first sample verbatim then eases toward new ones", () => {
    const s = createPointSmoother(0.5);
    expect(s.push(0, 0)).toEqual({ nx: 0, ny: 0 });
    // Half-way toward (1,1).
    expect(s.push(1, 1)).toEqual({ nx: 0.5, ny: 0.5 });
    expect(s.push(1, 1)).toEqual({ nx: 0.75, ny: 0.75 });
  });

  it("clamps the factor and never overshoots", () => {
    const s = createPointSmoother(5); // clamped to 1 → snappy
    s.push(0, 0);
    expect(s.push(1, 1)).toEqual({ nx: 1, ny: 1 });
  });

  it("reset clears state so the next sample is verbatim again", () => {
    const s = createPointSmoother(0.5);
    s.push(0, 0);
    s.push(1, 1);
    s.reset();
    expect(s.push(0.2, 0.8)).toEqual({ nx: 0.2, ny: 0.8 });
  });
});

describe("createDwellTracker", () => {
  it("commits only after the candidate is stable for dwellMs", () => {
    const d = createDwellTracker(500);
    expect(d.update("main", 0).commit).toBe(false);
    expect(d.update("main", 400).commit).toBe(false);
    expect(d.update("main", 500)).toEqual({ commit: true, target: "main" });
  });

  it("does not re-commit the already-focused window", () => {
    const d = createDwellTracker(500);
    d.update("main", 0);
    expect(d.update("main", 600).commit).toBe(true);
    expect(d.update("main", 1200).commit).toBe(false);
  });

  it("resets the timer when the candidate changes (hysteresis)", () => {
    const d = createDwellTracker(500);
    d.update("main", 0);
    expect(d.update("main", 600).commit).toBe(true);
    // Glance away briefly then back — must dwell again to switch.
    expect(d.update("project-1", 700).commit).toBe(false);
    expect(d.update("project-1", 900).commit).toBe(false);
    expect(d.update("project-1", 1200)).toEqual({ commit: true, target: "project-1" });
  });

  it("never commits a null (off-window) target", () => {
    const d = createDwellTracker(100);
    expect(d.update(null, 0).commit).toBe(false);
    expect(d.update(null, 500).commit).toBe(false);
  });
});
