"use client";

import { useEffect, useRef, useState } from "react";
import { clockTime, deviceKind, formatMetric, metricInfo, relativeTime, sortMetrics } from "@/lib/format";
import type { Alert, DeviceView } from "@/lib/types";
import { AlertFeed } from "./AlertFeed";
import { liveness } from "@/lib/store";
import { StatusDot } from "./Icons";
import { LineChart } from "./LineChart";

interface Props {
  device: DeviceView;
  alerts: Alert[];
  now: number;
  limitFor: (deviceId: string, metric: string) => number | undefined;
  onAck: (id: string) => Promise<void>;
  onClose: () => void;
}

export function DeviceDetail({ device, alerts, now, limitFor, onAck, onClose }: Props) {
  const [view, setView] = useState<"charts" | "table">("charts");
  const closeRef = useRef<HTMLButtonElement>(null);
  const metrics = sortMetrics(Object.keys(device.latest));

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Table view: one row per timestamp, newest first.
  const rows = (() => {
    const byTime = new Map<number, Record<string, number>>();
    for (const m of metrics) for (const p of device.history[m] ?? []) byTime.set(p.t, { ...byTime.get(p.t), [m]: p.v });
    return [...byTime.entries()].sort((a, b) => b[0] - a[0]).slice(0, 30);
  })();

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <h2 id="drawer-title">{device.id}</h2>
            <p className="muted">
              {deviceKind(device.id)} · {device.readingCount.toLocaleString()} readings · last seen {relativeTime(device.lastSeen, now)}
            </p>
          </div>
          <div className="drawer-actions">
            <StatusDot state={liveness(device, now)} />
            <button ref={closeRef} type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close details">
              ✕
            </button>
          </div>
        </header>

        <div className="segmented" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === "charts"} onClick={() => setView("charts")}>
            Charts
          </button>
          <button role="tab" aria-selected={view === "table"} onClick={() => setView("table")}>
            Table
          </button>
        </div>

        {view === "charts" ? (
          <div className="charts">
            {metrics.map((m) => (
              <LineChart key={m} metric={m} points={device.history[m] ?? []} limit={limitFor(device.id, m)} />
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  {metrics.map((m) => (
                    <th key={m} scope="col">
                      {metricInfo(m).label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(([t, vals]) => (
                  <tr key={t}>
                    <td>{clockTime(t)}</td>
                    {metrics.map((m) => (
                      <td key={m}>{formatMetric(m, vals[m])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="section-title">Alerts for this device</h3>
        <AlertFeed alerts={alerts} now={now} onAck={onAck} onOpenDevice={() => {}} compact />
      </aside>
    </div>
  );
}
