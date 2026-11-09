import { linePath, recent } from "@/lib/chart";
import type { Point } from "@/lib/types";

/** Cards show the last two minutes, so an old outage never squashes the current trend. */
const WINDOW_MS = 120_000;

interface Props {
  points: Point[];
  label: string;
  limit?: number | undefined;
  alert?: boolean;
  height?: number;
}

/** Tiny trend line for a device card: one series, no axes, no legend. */
export function Sparkline({ points: all, label, limit, alert = false, height = 44 }: Props) {
  const W = 200;
  const points = recent(all, WINDOW_MS);
  if (points.length < 2) {
    return <div className="spark-empty" style={{ height }} aria-label={`${label}: waiting for data`} />;
  }
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  let lo = Math.min(...points.map((p) => p.v));
  let hi = Math.max(...points.map((p) => p.v));
  if (limit !== undefined && limit - hi < (hi - lo) * 0.6) hi = Math.max(hi, limit); // show the limit only when it is near
  const pad = (hi - lo || 1) * 0.12;
  lo -= pad;
  hi += pad;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
  const y = (v: number) => height - ((v - lo) / (hi - lo)) * height;
  const d = linePath(points, x, y);
  const last = points[points.length - 1]!;
  const showLimit = limit !== undefined && limit <= hi && limit >= lo;

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: latest ${last.v.toFixed(1)}, range ${Math.min(...points.map((p) => p.v)).toFixed(1)} to ${Math.max(...points.map((p) => p.v)).toFixed(1)}`}
      style={{ height }}
    >
      {showLimit && <line x1={0} x2={W} y1={y(limit)} y2={y(limit)} className="spark-limit" vectorEffect="non-scaling-stroke" />}
      <path d={d} className={alert ? "spark-line spark-line--alert" : "spark-line"} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
