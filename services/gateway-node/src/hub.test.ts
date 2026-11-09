import { describe, expect, it } from "vitest";
import { HARD_LIMIT, Hub, SOFT_LIMIT, type ClientSocket, type OutEvent } from "./hub.js";

class FakeSocket implements ClientSocket {
  bufferedAmount = 0;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
}

const reading = (deviceId: string): OutEvent => ({ type: "reading", data: { deviceId, seq: 1 } });
const alert = (deviceId: string): OutEvent => ({ type: "alert", data: { type: "FIRED", alert: { deviceId } } });

describe("Hub", () => {
  it("fans out to every authenticated client", () => {
    const hub = new Hub();
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.add(a, "alice");
    hub.add(b, "bob");
    hub.broadcast(reading("pump-01"));
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0]!)).toEqual({ type: "reading", data: { deviceId: "pump-01", seq: 1 } });
  });

  it("respects per-client device filters, for alerts too", () => {
    const hub = new Hub();
    const s = new FakeSocket();
    hub.add(s, "alice");
    hub.setFilter(s, ["pump-01"]);
    hub.broadcast(reading("pump-02"));
    hub.broadcast(alert("pump-02"));
    hub.broadcast(reading("pump-01"));
    expect(s.sent).toHaveLength(1);
    hub.setFilter(s, null);
    hub.broadcast(reading("pump-02"));
    expect(s.sent).toHaveLength(2);
  });

  it("sheds readings for a slow client but still delivers alerts", () => {
    const hub = new Hub();
    const slow = new FakeSocket();
    const fast = new FakeSocket();
    hub.add(slow, "slow");
    hub.add(fast, "fast");
    slow.bufferedAmount = SOFT_LIMIT + 1;

    hub.broadcast(reading("pump-01"));
    hub.broadcast(alert("pump-01"));

    expect(slow.sent.map((m) => JSON.parse(m).type)).toEqual(["alert"]);
    expect(fast.sent).toHaveLength(2);
    expect(hub.stats().dropped).toBe(1);
  });

  it("evicts a hopelessly slow client instead of buffering without bound", () => {
    const hub = new Hub();
    const dead = new FakeSocket();
    hub.add(dead, "dead");
    dead.bufferedAmount = HARD_LIMIT + 1;
    hub.broadcast(alert("pump-01"));
    expect(dead.closed).toEqual({ code: 1013, reason: "client too slow" });
    expect(hub.has(dead)).toBe(false);
    expect(hub.stats().evicted).toBe(1);
  });

  it("does no work with no clients", () => {
    const hub = new Hub();
    hub.broadcast(reading("pump-01"));
    expect(hub.stats().sent).toBe(0);
  });
});
