import mqtt, { type MqttClient } from "mqtt";
import type { FastifyBaseLogger } from "fastify";
import type { Hub, OutEvent } from "./hub.js";

const READINGS = "pulse/v1/internal/readings";
const STATUS = "pulse/v1/internal/status";
const ALERTS = "pulse/v1/internal/alerts";

/** Turns a broker message into a hub event, or null if it is not something we understand. */
export function toEvent(topic: string, payload: Buffer): OutEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  switch (topic) {
    case READINGS:
      return typeof obj.deviceId === "string"
        ? { type: "reading", data: obj as { deviceId: string } & Record<string, unknown> }
        : null;
    case STATUS:
      return typeof obj.deviceId === "string" && typeof obj.online === "boolean"
        ? { type: "status", data: obj as { deviceId: string; online: boolean; at: number } }
        : null;
    case ALERTS: {
      const alert = obj.alert as Record<string, unknown> | undefined;
      return typeof obj.type === "string" && alert && typeof alert.deviceId === "string"
        ? { type: "alert", data: obj as { type: string; alert: { deviceId: string } } }
        : null;
    }
    default:
      return null;
  }
}

export function connectBroker(url: string, serviceToken: string, hub: Hub, log: FastifyBaseLogger): MqttClient {
  const client = mqtt.connect(url, {
    clientId: `pulse-gateway-${process.pid}`,
    username: "svc:gateway",
    password: serviceToken,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
  });
  client.on("connect", () => {
    log.info({ url }, "mqtt connected");
    client.subscribe([READINGS, STATUS, ALERTS], { qos: 0 }, (err) => {
      if (err) log.error({ err }, "mqtt subscribe failed");
    });
  });
  client.on("reconnect", () => log.warn("mqtt reconnecting"));
  client.on("error", (err) => log.error({ err: err.message }, "mqtt error"));
  client.on("message", (topic, payload) => {
    const ev = toEvent(topic, payload);
    if (ev) hub.broadcast(ev);
  });
  return client;
}
