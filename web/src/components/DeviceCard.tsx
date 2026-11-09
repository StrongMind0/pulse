import { deviceKind, formatMetric, metricInfo, relativeTime, sortMetrics } from "@/lib/format";
import { liveness } from "@/lib/store";
import type { Alert, DeviceView } from "@/lib/types";
import { SeverityBadge, StatusDot } from "./Icons";
import { Sparkline } from "./Sparkline";

interface Props {
  device: DeviceView;
  firing: Alert[];
  now: number;
  limitFor: (deviceId: string, metric: string) => number | undefined;
  onOpen: (id: string) => void;
}

export function DeviceCard({ device, firing, now, limitFor, onOpen }: Props) {
  const metrics = sortMetrics(Object.keys(device.latest));
  const primary = metrics[0];
  const worst = firing.find((a) => a.severity === "CRITICAL") ?? firing[0];
  const state = liveness(device, now);

  return (
    <button
      type="button"
      className={`card device ${worst ? `device--${worst.severity.toLowerCase()}` : ""}`}
      onClick={() => onOpen(device.id)}
      aria-label={`${device.id}, ${state}${firing.length ? `, ${firing.length} alert${firing.length > 1 ? "s" : ""} firing` : ""}. Open details.`}
    >
      <div className="device-head">
        <div>
          <div className="device-id">{device.id}</div>
          <div className="device-kind">{deviceKind(device.id)}</div>
        </div>
        <StatusDot state={state} />
      </div>

      {primary && (
        <>
          <div className="device-primary">
            <span className="device-primary-value">{formatMetric(primary, device.latest[primary])}</span>
            <span className="device-primary-label">{metricInfo(primary).label}</span>
          </div>
          <Sparkline
            points={device.history[primary] ?? []}
            label={`${device.id} ${metricInfo(primary).label}`}
            limit={limitFor(device.id, primary)}
            alert={!!worst}
          />
        </>
      )}

      <dl className="device-metrics">
        {metrics.slice(1).map((m) => (
          <div key={m}>
            <dt>{metricInfo(m).label}</dt>
            <dd>{formatMetric(m, device.latest[m])}</dd>
          </div>
        ))}
      </dl>

      <div className="device-foot">
        {worst ? <SeverityBadge severity={worst.severity} /> : <span className="muted">No active alerts</span>}
        <span className="muted">{device.lastSeen ? relativeTime(device.lastSeen, now) : "never seen"}</span>
      </div>
      {worst && <div className="device-alert-msg">{worst.ruleName}</div>}
    </button>
  );
}
