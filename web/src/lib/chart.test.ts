import { describe, expect, it } from "vitest";
import { gapThreshold, linePath, recent } from "./chart";

const series = (ts: number[]) => ts.map((t) => ({ t, v: 1 }));
const id = (n: number) => n;

describe("chart helpers", () => {
  it("draws one continuous line for evenly spaced data", () => {
    const d = linePath(series([0, 1000, 2000, 3000]), id, id);
    expect(d.match(/M/g)).toHaveLength(1);
  });

  it("lifts the pen across a gap instead of inventing a straight line", () => {
    // 1 s cadence, then the stack was down for four minutes
    const d = linePath(series([0, 1000, 2000, 242_000, 243_000, 244_000]), id, id);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).toContain("M242000.0");
  });

  it("never treats normal jitter as a gap", () => {
    const jittery = series([0, 1000, 2100, 2900, 4000, 5300, 6000]);
    expect(gapThreshold(jittery)).toBeGreaterThanOrEqual(5000);
    expect(linePath(jittery, id, id).match(/M/g)).toHaveLength(1);
  });

  it("scales the gap threshold with slow sample rates", () => {
    expect(gapThreshold(series([0, 10_000, 20_000, 30_000]))).toBe(50_000);
  });

  it("keeps only the recent window", () => {
    const pts = series([0, 1000, 200_000, 201_000, 202_000]);
    expect(recent(pts, 120_000).map((p) => p.t)).toEqual([200_000, 201_000, 202_000]);
    expect(recent([], 1000)).toEqual([]);
  });
});
