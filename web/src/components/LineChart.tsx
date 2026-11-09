"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clockTime, formatMetric, metricInfo } from "@/lib/format";
import type { Point } from "@/lib/types";

interface Props {
  metric: string;
  points: Point[];
  limit?: number | undefined;
  height?: number;
}

const M = { top: 10, right: 14, bottom: 24, left: 46 };

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/**
 * Single-series time chart with a hover/keyboard crosshair. One metric per
 * chart: metrics with different units get their own charts (small
 * multiples), never a second y-axis.
 */
export function LineChart({ metric, points, limit, height = 180 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const info = metricInfo(metric);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length < 2 || width === 0) return null;
    const t0 = points[0]!.t;
    const t1 = points[points.length - 1]!.t;
    let lo = Math.min(...points.map((p) => p.v));
    let hi = Math.max(...points.map((p) => p.v));
    if (limit !== undefined && limit - hi < (hi - lo) * 0.6) {
      hi = Math.max(hi, limit);
      lo = Math.min(lo, limit);
    }
    const pad = (hi - lo || 1) * 0.1;
    lo -= pad;
    hi += pad;
    const iw = width - M.left - M.right;
    const ih = height - M.top - M.bottom;
    const x = (t: number) => M.left + ((t - t0) / (t1 - t0 || 1)) * iw;
    const y = (v: number) => M.top + ih - ((v - lo) / (hi - lo)) * ih;
    const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    const yTicks = niceTicks(lo, hi, 4).filter((v) => v >= lo && v <= hi);
    const xTicks = [0, 1 / 3, 2 / 3, 1].map((f) => t0 + f * (t1 - t0));
    return { x, y, path, yTicks, xTicks, lo, hi, iw, ih };
  }, [points, width, height, limit]);

  const nearest = (clientX: number): number | null => {
    if (!geo || !wrap.current) return null;
    const px = clientX - wrap.current.getBoundingClientRect().left;
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (geo.x(points[mid]!.t) < px) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(geo.x(points[lo - 1]!.t) - px) < Math.abs(geo.x(points[lo]!.t) - px)) lo--;
    return lo;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? points.length) - 1));
    else if (e.key === "ArrowRight") setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  const hp = hover !== null ? points[hover] : undefined;
  const latest = points[points.length - 1];
  const showLimit = geo && limit !== undefined && limit >= geo.lo && limit <= geo.hi;

  return (
    <figure className="chart">
      <figcaption className="chart-title">
        <span>{info.label}</span>
        <span className="chart-latest">{formatMetric(metric, latest?.v)}</span>
      </figcaption>
      <div
        ref={wrap}
        className="chart-plot"
        style={{ height }}
        tabIndex={0}
        role="img"
        aria-label={`${info.label} over time. Use left and right arrow keys to inspect values.`}
        onKeyDown={onKey}
        onPointerMove={(e: PointerEvent) => setHover(nearest(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
      >
        {geo ? (
          <svg width={width} height={height} aria-hidden="true">
            {geo.yTicks.map((v) => (
              <g key={v}>
                <line x1={M.left} x2={M.left + geo.iw} y1={geo.y(v)} y2={geo.y(v)} className="gridline" />
                <text x={M.left - 8} y={geo.y(v)} className="tick" textAnchor="end" dominantBaseline="middle">
                  {v.toFixed(info.digits)}
                </text>
              </g>
            ))}
            <line x1={M.left} x2={M.left + geo.iw} y1={M.top + geo.ih} y2={M.top + geo.ih} className="baseline" />
            {geo.xTicks.map((t, i) => (
              <text key={i} x={geo.x(t)} y={height - 6} className="tick" textAnchor={i === 0 ? "start" : i === 3 ? "end" : "middle"}>
                {clockTime(t)}
              </text>
            ))}
            {showLimit && (
              <g>
                <line x1={M.left} x2={M.left + geo.iw} y1={geo.y(limit)} y2={geo.y(limit)} className="limit" />
                <text x={M.left + geo.iw} y={geo.y(limit) - 5} className="limit-label" textAnchor="end">
                  alert limit {formatMetric(metric, limit)}
                </text>
              </g>
            )}
            <path d={geo.path} className="series" />
            {hp && (
              <g>
                <line x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={M.top} y2={M.top + geo.ih} className="crosshair" />
                <circle cx={geo.x(hp.t)} cy={geo.y(hp.v)} r={5} className="marker" />
              </g>
            )}
          </svg>
        ) : (
          <div className="chart-empty">Waiting for data…</div>
        )}
        {hp && geo && (
          <div
            className="tooltip"
            style={{
              left: Math.min(Math.max(geo.x(hp.t), 70), width - 70),
              top: Math.max(geo.y(hp.v) - 12, 0),
            }}
          >
            <strong>{formatMetric(metric, hp.v)}</strong>
            <span>{clockTime(hp.t)}</span>
          </div>
        )}
      </div>
    </figure>
  );
}
