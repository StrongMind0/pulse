# Architecture

## Data flow, end to end

1. **Device** samples its sensors once a second, formats
   `{"seq":N,"ts":MS,"metrics":{...}}`, pushes it into its outbox, and publishes it at QoS 1 to
   `pulse/v1/devices/{id}/telemetry`.
2. **Ingest** authenticates the connection, checks the topic ACL, validates the payload, drops
   duplicates, and offers the reading to a bounded queue. The PUBACK goes out only if the queue
   accepted it.
3. A single writer drains the queue in batches (500 readings or 250 ms, whichever comes first)
   into SQLite in one transaction, then republishes the batch on `pulse/v1/internal/readings`.
4. **Rules** consumes the internal stream, keeps a sliding window per device (64 readings or
   120 s), evaluates each rule, and drives the per-device, per-rule state machine. Transitions
   are published on `pulse/v1/internal/alerts`.
5. **Gateway** subscribes to readings, status and alerts, and fans them out to authenticated
   WebSocket clients. It also proxies REST queries to ingest and rules.
6. **Dashboard** loads a REST snapshot, then applies the live stream, batching events into one
   React update per animation frame.

End-to-end latency from device to dashboard is bounded mainly by the 250 ms batch flush
interval, which trades latency for write efficiency (configurable). Measured numbers come with
the Phase 3 load tests.

## Topics

| Topic | Publisher | Subscribers | Payload |
|---|---|---|---|
| `pulse/v1/devices/{id}/telemetry` | that device only | none (swallowed by ingest) | raw reading |
| `pulse/v1/internal/readings` | ingest (after commit) | rules, gateway | validated reading |
| `pulse/v1/internal/status` | ingest | gateway | `{deviceId, online, at}` |
| `pulse/v1/internal/alerts` | rules | gateway | `{type: FIRED, RESOLVED or ACKNOWLEDGED, alert}` |

Topics are versioned (`v1`) so the wire format can evolve without breaking deployed firmware.

## Alert state machine

```
        trigger                held >= forMillis
  OK ───────────────► PENDING ─────────────────► FIRING
   ▲                     │                          │
   │   trigger stops     │                          │ clear (below clear threshold)
   └─────────────────────┘◄─────────────────────────┘
```

Rules are pure functions from a reading window to a `Signal(trigger, clear, value, detail)`.
All state (timers, the open alert id) lives in the engine, which is what makes the rules
trivially unit-testable and the engine's guarantees (one open alert per device and rule)
enforceable in one place.

## Ports

| Service | Port | Endpoints |
|---|---|---|
| ingest | 1883 | MQTT |
| ingest | 8081 | `/healthz`, `/readyz`, `/metrics`, `/api/v1/devices`, `/api/v1/devices/{id}/readings` |
| rules | 8082 | `/actuator/health`, `/actuator/prometheus`, `/api/v1/alerts`, `/api/v1/alerts/{id}/ack`, `/api/v1/rules` |
| gateway | 8080 | `/api/auth/login`, `/api/*` (JWT), `/ws`, `/healthz`, `/metrics` |
| web | 3000 | dashboard |
