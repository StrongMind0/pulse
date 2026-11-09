import { describe, expect, it } from "vitest";
import { HISTORY_POINTS, firingByDevice, initialState, reducer } from "./store";
import type { Alert, Reading } from "./types";

const reading = (seq: number, ts: number, temp = 20): Reading => ({
  deviceId: "pump-01",
  seq,
  ts,
  receivedAt: ts,
  metrics: { temperature_c: temp },
});

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: "a1",
  deviceId: "pump-01",
  ruleId: "pump-overheat",
  ruleName: "Pump overheating",
  severity: "CRITICAL",
  state: "FIRING",
  message: "hot",
  triggerValue: 80,
  firedAt: 1,
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  ...over,
});

describe("live store reducer", () => {
  it("builds device views from a snapshot", () => {
    const s = reducer(initialState, {
      type: "snapshot",
      devices: [{ id: "pump-01", firstSeen: 0, lastSeen: 2, lastSeq: 2, online: true, readingCount: 2 }],
      alerts: [alert()],
      history: { "pump-01": [reading(1, 1), reading(2, 2, 25)] },
    });
    expect(s.devices["pump-01"]?.latest.temperature_c).toBe(25);
    expect(s.devices["pump-01"]?.history.temperature_c).toHaveLength(2);
    expect(s.devices["pump-01"]?.readingCount).toBe(2);
    expect(Object.keys(s.alerts)).toEqual(["a1"]);
  });

  it("ignores live readings the snapshot already contains", () => {
    let s = reducer(initialState, {
      type: "snapshot",
      devices: [{ id: "pump-01", firstSeen: 0, lastSeen: 2, lastSeq: 2, online: true, readingCount: 2 }],
      alerts: [],
      history: { "pump-01": [reading(1, 1), reading(2, 2)] },
    });
    const before = s;
    s = reducer(s, { type: "batch", events: [{ type: "reading", data: reading(2, 2) }] });
    expect(s).toBe(before); // nothing changed, no re-render
    s = reducer(s, { type: "batch", events: [{ type: "reading", data: reading(3, 3) }] });
    expect(s.devices["pump-01"]?.readingCount).toBe(3);
  });

  it("caps history so memory stays bounded", () => {
    const events = Array.from({ length: HISTORY_POINTS + 50 }, (_, i) => ({ type: "reading" as const, data: reading(i, i + 1) }));
    const s = reducer(initialState, { type: "batch", events });
    const h = s.devices["pump-01"]!.history.temperature_c!;
    expect(h).toHaveLength(HISTORY_POINTS);
    expect(h[h.length - 1]!.t).toBe(HISTORY_POINTS + 50);
  });

  it("applies status changes and creates unknown devices", () => {
    const s = reducer(initialState, { type: "batch", events: [{ type: "status", data: { deviceId: "fan-09", online: true, at: 5 } }] });
    expect(s.devices["fan-09"]?.online).toBe(true);
  });

  it("never lets a late FIRED event resurrect a resolved alert", () => {
    let s = reducer(initialState, { type: "alert", alert: alert({ state: "RESOLVED", resolvedAt: 9 }) });
    s = reducer(s, { type: "batch", events: [{ type: "alert", data: { type: "FIRED", alert: alert() } }] });
    expect(s.alerts.a1?.state).toBe("RESOLVED");
  });

  it("groups firing alerts by device", () => {
    let s = reducer(initialState, { type: "alert", alert: alert() });
    s = reducer(s, { type: "alert", alert: alert({ id: "a2", state: "RESOLVED" }) });
    const map = firingByDevice(s.alerts);
    expect(map.get("pump-01")?.map((a) => a.id)).toEqual(["a1"]);
  });
});
