"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { limitLookup, type RuleDef } from "@/lib/api";
import { firingByDevice, liveness } from "@/lib/store";
import type { Session } from "@/lib/types";
import { useLive, useNow } from "@/lib/useLive";
import { AlertFeed } from "./AlertFeed";
import { DeviceCard } from "./DeviceCard";
import { DeviceDetail } from "./DeviceDetail";
import { Logo } from "./Icons";

interface Props {
  session: Session;
  onLogout: () => void;
}

export function Dashboard({ session, onLogout }: Props) {
  const { state, connection, rate, acknowledge, client } = useLive(session, onLogout);
  const now = useNow(1000);
  const [selected, setSelected] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleDef[]>([]);
  const [filter, setFilter] = useState<"all" | "alerting" | "offline">("all");

  useEffect(() => {
    client.rules().then((r) => setRules(r.rules), () => setRules([]));
  }, [client]);

  const limitFor = useMemo(() => limitLookup(rules), [rules]);
  const firing = useMemo(() => firingByDevice(state.alerts), [state.alerts]);
  const devices = useMemo(() => Object.values(state.devices).sort((a, b) => a.id.localeCompare(b.id)), [state.devices]);
  const alerts = useMemo(() => Object.values(state.alerts), [state.alerts]);

  const live = new Map(devices.map((d) => [d.id, liveness(d, now)]));
  const reporting = devices.filter((d) => live.get(d.id) === "online").length;
  const critical = alerts.filter((a) => a.state === "FIRING" && a.severity === "CRITICAL").length;
  const warning = alerts.filter((a) => a.state === "FIRING" && a.severity === "WARNING").length;
  const unacked = alerts.filter((a) => a.state === "FIRING" && !a.acknowledgedAt).length;

  const visible = devices.filter((d) =>
    filter === "alerting" ? firing.has(d.id) : filter === "offline" ? live.get(d.id) !== "online" : true,
  );
  const selectedDevice = selected ? state.devices[selected] : undefined;
  const close = useCallback(() => setSelected(null), []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>Pulse</span>
        </div>
        <div className={`conn conn--${connection}`} role="status" aria-live="polite">
          <span aria-hidden="true" />
          {connection === "live" ? "Live" : connection === "connecting" ? "Connecting…" : "Reconnecting…"}
        </div>
        <div className="topbar-right">
          <span className="muted">{session.user}</span>
          <button type="button" className="btn btn--ghost" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        <section className="tiles" aria-label="Fleet summary">
          <div className="card tile">
            <div className="tile-label">Devices reporting</div>
            <div className="tile-value">
              {reporting}
              <span className="tile-of"> / {devices.length}</span>
            </div>
          </div>
          <div className="card tile">
            <div className="tile-label">Readings per second</div>
            <div className="tile-value">{rate}</div>
          </div>
          <div className={`card tile ${critical ? "tile--critical" : ""}`}>
            <div className="tile-label">Critical alerts</div>
            <div className="tile-value">{critical}</div>
          </div>
          <div className={`card tile ${warning ? "tile--warning" : ""}`}>
            <div className="tile-label">Warnings</div>
            <div className="tile-value">{warning}</div>
          </div>
          <div className="card tile">
            <div className="tile-label">Unacknowledged</div>
            <div className="tile-value">{unacked}</div>
          </div>
        </section>

        <div className="layout">
          <section aria-labelledby="fleet-title">
            <div className="section-head">
              <h2 id="fleet-title" className="section-title">
                Fleet
              </h2>
              <div className="segmented" role="radiogroup" aria-label="Filter devices">
                {(["all", "alerting", "offline"] as const).map((f) => (
                  <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}>
                    {f === "all" ? `All (${devices.length})` : f === "alerting" ? `Alerting (${firing.size})` : `Not reporting (${devices.length - reporting})`}
                  </button>
                ))}
              </div>
            </div>
            {devices.length === 0 ? (
              <div className="card empty-state">
                <h3>No devices yet</h3>
                <p className="muted">
                  {connection === "live" ? (
                    <>
                      Devices appear here as soon as they connect. <code>npm run dev</code> starts a simulated fleet.
                    </>
                  ) : (
                    "Connecting to the gateway…"
                  )}
                </p>
              </div>
            ) : (
              <div className="grid">
                {visible.map((d) => (
                  <DeviceCard key={d.id} device={d} firing={firing.get(d.id) ?? []} now={now} limitFor={limitFor} onOpen={setSelected} />
                ))}
              </div>
            )}
          </section>

          <section className="card panel" aria-labelledby="alerts-title">
            <h2 id="alerts-title" className="section-title">
              Alerts
            </h2>
            <AlertFeed alerts={alerts} now={now} onAck={acknowledge} onOpenDevice={setSelected} />
          </section>
        </div>
      </main>

      {selectedDevice && (
        <DeviceDetail
          device={selectedDevice}
          alerts={alerts.filter((a) => a.deviceId === selectedDevice.id)}
          now={now}
          limitFor={limitFor}
          onAck={acknowledge}
          onClose={close}
        />
      )}
    </div>
  );
}
