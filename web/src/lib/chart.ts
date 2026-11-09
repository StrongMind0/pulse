import type { Point } from "./types";

/** Smallest gap that always counts as missing data, whatever the sample rate. */
const MIN_GAP_MS = 5_000;

/**
 * The time step above which two neighbouring points are treated as a gap:
 * five times the typical (median) interval, and never under five seconds.
 */
export function gapThreshold(points: Point[]): number {
  if (points.length < 3) return Number.POSITIVE_INFINITY;
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) steps.push(points[i]!.t - points[i - 1]!.t);
  steps.sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)]!;
  return Math.max(MIN_GAP_MS, median * 5);
}

/**
 * SVG path that lifts the pen across gaps. Drawing a straight line through
 * missing data invents values that were never measured.
 */
export function linePath(points: Point[], x: (t: number) => number, y: (v: number) => number): string {
  const gap = gapThreshold(points);
  let d = "";
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const jump = i === 0 || p.t - points[i - 1]!.t > gap;
    d += `${jump ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
  }
  return d;
}

/** The most recent window of points, for compact trend displays. */
export function recent(points: Point[], windowMs: number): Point[] {
  const last = points[points.length - 1];
  if (!last) return points;
  const from = last.t - windowMs;
  let i = points.length - 1;
  while (i > 0 && points[i - 1]!.t >= from) i--;
  return points.slice(i);
}
