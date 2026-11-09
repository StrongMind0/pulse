import type { Alert, Device, DeviceView, LiveEvent, Reading } from "./types";

export const HISTORY_POINTS = 120;

export interface LiveState {
  devices: Record<string, DeviceView>;
  alerts: Record<string, Alert>;
}

export type Action =
  | { type: "snapshot"; devices: Device[]; alerts: Alert[]; history: Record<string, Reading[]> }
  | { type: "batch"; events: LiveEvent[] }
  | { type: "alert"; alert: Alert }
  | { type: "reset" };

export const initialState: LiveState = { devices: {}, alerts: {} };

function emptyDevice(id: string): DeviceView {
  return { id, online: false, lastSeen: 0, readingCount: 0, latest: {}, history: {} };
}

/** Appends a reading, keeping per-metric history bounded and time-ordered. */
function applyReading(d: DeviceView, r: Reading): DeviceView {
  const history = { ...d.history };
  let added = false;
  for (const [name, v] of Object.entries(r.metrics)) {
    const prev = history[name] ?? [];
    const last = prev[prev.length - 1];
    if (last && last.t >= r.ts) continue; // duplicate or out of order: the snapshot already has it
    const next = prev.length >= HISTORY_POINTS ? prev.slice(prev.length - HISTORY_POINTS + 1) : prev.slice();
    next.push({ t: r.ts, v });
    history[name] = next;
    added = true;
  }
  if (!added) return d;
  return {
    ...d,
    online: true,
    lastSeen: Math.max(d.lastSeen, r.receivedAt),
    readingCount: d.readingCount + 1,
    latest: { ...d.latest, ...r.metrics },
    history,
  };
}

/**
 * A newer alert version replaces an older one. Ordering by lifecycle stage
 * keeps a late-arriving FIRED event from resurrecting a RESOLVED alert.
 */
function newer(a: Alert, b: Alert | undefined): boolean {
  if (!b) return true;
  const rank = (x: Alert) => (x.state === "RESOLVED" ? 2 : 0) + (x.acknowledgedAt ? 1 : 0);
  return rank(a) >= rank(b);
}

export function reducer(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case "reset":
      return initialState;

    case "snapshot": {
      const devices: Record<string, DeviceView> = {};
      for (const d of action.devices) {
        let view: DeviceView = { ...emptyDevice(d.id), lastSeen: d.lastSeen };
        for (const r of action.history[d.id] ?? []) view = applyReading(view, r);
        devices[d.id] = { ...view, online: d.online, readingCount: d.readingCount };
      }
      const alerts: Record<string, Alert> = {};
      for (const a of action.alerts) alerts[a.id] = a;
      return { devices, alerts };
    }

    case "alert":
      return newer(action.alert, state.alerts[action.alert.id])
        ? { ...state, alerts: { ...state.alerts, [action.alert.id]: action.alert } }
        : state;

    case "batch": {
      let devices = state.devices;
      let alerts = state.alerts;
      // Copy-on-first-write, and only when something actually changed, so a
      // batch of duplicates returns the same state and React skips the render.
      const put = (id: string, next: DeviceView, prev: DeviceView | undefined) => {
        if (next === prev) return;
        if (devices === state.devices) devices = { ...state.devices };
        devices[id] = next;
      };
      for (const ev of action.events) {
        if (ev.type === "reading") {
          const prev = devices[ev.data.deviceId];
          put(ev.data.deviceId, applyReading(prev ?? emptyDevice(ev.data.deviceId), ev.data), prev);
        } else if (ev.type === "status") {
          const prev = devices[ev.data.deviceId];
          if (prev?.online !== ev.data.online) {
            put(ev.data.deviceId, { ...(prev ?? emptyDevice(ev.data.deviceId)), online: ev.data.online }, prev);
          }
        } else if (newer(ev.data.alert, alerts[ev.data.alert.id])) {
          if (alerts === state.alerts) alerts = { ...state.alerts };
          alerts[ev.data.alert.id] = ev.data.alert;
        }
      }
      return devices === state.devices && alerts === state.alerts ? state : { devices, alerts };
    }
  }
}

export function firingByDevice(alerts: Record<string, Alert>): Map<string, Alert[]> {
  const out = new Map<string, Alert[]>();
  for (const a of Object.values(alerts)) {
    if (a.state !== "FIRING") continue;
    const list = out.get(a.deviceId) ?? [];
    list.push(a);
    out.set(a.deviceId, list);
  }
  return out;
}
