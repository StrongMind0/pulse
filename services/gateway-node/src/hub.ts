/**
 * Realtime fan-out to dashboard WebSocket clients.
 *
 * The hard problem here is the slow client: a laptop on hotel Wi-Fi cannot
 * keep up with a fleet streaming readings, and if we keep writing to it the
 * kernel buffer fills and Node buffers the rest in memory, for every slow
 * client, until the process dies. So, per client:
 *
 *   - below SOFT_LIMIT buffered bytes: send everything
 *   - above SOFT_LIMIT: shed readings (the next one supersedes it anyway),
 *     but still deliver alerts and status changes, which must not be lost
 *   - above HARD_LIMIT: the client is hopeless; close it with 1013 so it
 *     reconnects and resyncs from the REST API
 */

export const SOFT_LIMIT = 256 * 1024;
export const HARD_LIMIT = 4 * 1024 * 1024;

export interface ClientSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason: string): void;
}

export type OutEvent =
  | { type: "reading"; data: { deviceId: string } & Record<string, unknown> }
  | { type: "status"; data: { deviceId: string; online: boolean; at: number } }
  | { type: "alert"; data: { type: string; alert: { deviceId: string } & Record<string, unknown> } };

interface ClientState {
  user: string;
  devices: Set<string> | null; // null = all devices
  dropped: number;
}

export interface HubStats {
  clients: number;
  sent: number;
  dropped: number;
  evicted: number;
}

export class Hub {
  private readonly clients = new Map<ClientSocket, ClientState>();
  private sent = 0;
  private dropped = 0;
  private evicted = 0;

  add(sock: ClientSocket, user: string): void {
    this.clients.set(sock, { user, devices: null, dropped: 0 });
  }

  remove(sock: ClientSocket): void {
    this.clients.delete(sock);
  }

  has(sock: ClientSocket): boolean {
    return this.clients.has(sock);
  }

  setFilter(sock: ClientSocket, devices: string[] | null): void {
    const c = this.clients.get(sock);
    if (c) c.devices = devices ? new Set(devices) : null;
  }

  broadcast(event: OutEvent): void {
    if (this.clients.size === 0) return;
    const deviceId = event.type === "alert" ? event.data.alert.deviceId : event.data.deviceId;
    const payload = JSON.stringify(event); // serialise once, not once per client
    const sheddable = event.type === "reading";

    for (const [sock, c] of this.clients) {
      if (c.devices && !c.devices.has(deviceId)) continue;
      const buffered = sock.bufferedAmount;
      if (buffered > HARD_LIMIT) {
        this.clients.delete(sock);
        this.evicted++;
        sock.close(1013, "client too slow");
        continue;
      }
      if (sheddable && buffered > SOFT_LIMIT) {
        c.dropped++;
        this.dropped++;
        continue;
      }
      sock.send(payload);
      this.sent++;
    }
  }

  stats(): HubStats {
    return { clients: this.clients.size, sent: this.sent, dropped: this.dropped, evicted: this.evicted };
  }
}
