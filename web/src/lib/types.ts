export interface Reading {
  deviceId: string;
  seq: number;
  ts: number;
  receivedAt: number;
  metrics: Record<string, number>;
  clockSkew?: boolean;
}

export interface Device {
  id: string;
  firstSeen: number;
  lastSeen: number;
  lastSeq: number;
  online: boolean;
  readingCount: number;
}

export type Severity = "INFO" | "WARNING" | "CRITICAL";

export interface Alert {
  id: string;
  deviceId: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  state: "FIRING" | "RESOLVED";
  message: string;
  triggerValue: number;
  firedAt: number;
  resolvedAt: number | null;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
}

export interface Session {
  token: string;
  user: string;
  expiresAt: number;
}

export interface Point {
  t: number;
  v: number;
}

/** Client-side view of a device: REST snapshot + live stream merged. */
export interface DeviceView {
  id: string;
  online: boolean;
  lastSeen: number;
  readingCount: number;
  latest: Record<string, number>;
  history: Record<string, Point[]>;
}

export type LiveEvent =
  | { type: "reading"; data: Reading }
  | { type: "status"; data: { deviceId: string; online: boolean; at: number } }
  | { type: "alert"; data: { type: "FIRED" | "RESOLVED" | "ACKNOWLEDGED"; alert: Alert } };
