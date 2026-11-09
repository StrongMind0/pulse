"use client";

import { useState } from "react";
import { relativeTime } from "@/lib/format";
import type { Alert } from "@/lib/types";
import { SeverityBadge } from "./Icons";

interface Props {
  alerts: Alert[];
  now: number;
  onAck: (id: string) => Promise<void>;
  onOpenDevice: (id: string) => void;
  compact?: boolean;
}

const sevRank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;

/** Firing first (worst severity, then newest), then recently resolved. */
export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => {
    if (a.state !== b.state) return a.state === "FIRING" ? -1 : 1;
    if (a.state === "FIRING" && a.severity !== b.severity) return sevRank[a.severity] - sevRank[b.severity];
    return (b.resolvedAt ?? b.firedAt) - (a.resolvedAt ?? a.firedAt);
  });
}

export function AlertFeed({ alerts, now, onAck, onOpenDevice, compact = false }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sorted = sortAlerts(alerts).slice(0, compact ? 20 : 60);

  if (sorted.length === 0) {
    return <p className="empty">All quiet. No alerts yet.</p>;
  }

  const ack = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await onAck(id);
    } catch {
      setError("Could not acknowledge. Is the gateway reachable?");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ul className="alerts" aria-live="polite">
        {sorted.map((a) => (
          <li key={a.id} className={`alert ${a.state === "RESOLVED" ? "alert--resolved" : ""}`}>
            <div className="alert-row">
              {a.state === "FIRING" ? <SeverityBadge severity={a.severity} /> : <span className="resolved-tag">Resolved</span>}
              <button type="button" className="link" onClick={() => onOpenDevice(a.deviceId)}>
                {a.deviceId}
              </button>
              <span className="muted alert-time">{relativeTime(a.resolvedAt ?? a.firedAt, now)}</span>
            </div>
            <div className="alert-name">{a.ruleName}</div>
            <div className="alert-msg">{a.message.split(" | ")[0]}</div>
            {a.state === "FIRING" && (
              <div className="alert-actions">
                {a.acknowledgedBy ? (
                  <span className="muted">Acknowledged by {a.acknowledgedBy}</span>
                ) : (
                  <button type="button" className="btn btn--small" disabled={busy === a.id} onClick={() => ack(a.id)}>
                    {busy === a.id ? "Acknowledging…" : "Acknowledge"}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
