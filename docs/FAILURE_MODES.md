# Failure modes

What breaks, what Pulse does about it, and what it still does not handle. Each entry names the
code or test that backs the claim.

## Devices and the network

| Failure | Behaviour | Where |
|---|---|---|
| Wi-Fi drops for a while | Readings queue in a fixed 64-entry outbox. On reconnect, in-flight messages are resent with DUP set and the queue flushes. If the outage outlasts the outbox, the **oldest** readings are evicted (the newest are worth most) and counted. | `firmware/core/src/outbox.c`, `outbox_overflow_evicts_oldest` |
| Broker restarts and every device reconnects at once | Exponential backoff with **full jitter** (500 ms up to 30 s) spreads reconnects out instead of a thundering herd. | `firmware/core/src/backoff.c` |
| QoS 1 redelivery (the broker gets the same message twice) | Ingest drops duplicates by `(boot, seq)`. Each device picks a random **boot id** at power-on, and seq restarts at 1. A new boot id always starts a fresh sequence, so a reboot is never mistaken for duplicates. *Found the hard way:* comparing seq alone discarded every reading after a restart until seq overtook the old value. | `telemetry.IsDuplicate`, `TestRebootedDeviceIsNotTreatedAsDuplicates` |
| Schema changes on an existing database | Versioned migrations tracked in SQLite's `user_version`, applied in order exactly once at startup. | `TestMigratesOldDatabase` |
| Device clock wrong (an ESP32 without NTP boots at 1970) | Timestamps more than 5 minutes off are replaced with server time and flagged `clockSkew`. Rules use the corrected time. | `telemetry.Parse` |
| TCP half-open (the peer vanished without closing) | MQTT keepalive: the device pings at half the interval and drops the link if no PINGRESP arrives. The gateway pings WebSockets every 30 s and terminates silent ones. | `firmware/sim/device.c`, `gateway-node/src/server.ts` |
| Malformed or hostile payloads | Strict validation: size cap, metric count cap, name pattern, finite numbers, topic shape. Rejections are counted by reason. | `TestParse` |
| A device impersonates another, or a service injects device data | Topic ACLs: a device may publish only to its own topic, and a service may never publish telemetry. MQTT 3.1.1 has no negative ack, so the violator is disconnected. | `TestACLViolationsDisconnectAndAreDiscarded` |

## Ingest

| Failure | Behaviour | Where |
|---|---|---|
| Database slower than incoming traffic | A bounded queue (10k readings). When it is full, the broker **withholds the PUBACK**, so QoS 1 devices keep the message and retry: backpressure reaches the edge instead of silently losing data. `/readyz` reports `overloaded` at 90% full. | `broker.Hook.OnPublish`, `api.go` |
| Database write fails | Retries with exponential backoff, five attempts, then the batch is dropped and counted (`dropped_total{reason="store_failure"}`). Blocking forever would turn an outage into a memory leak. The dropped batch is never announced downstream. | `TestGivesUpAfterMaxRetries` |
| Process stopped (SIGTERM) | Stop accepting device traffic, drain the queue to the database, then stop HTTP. | `TestShutdownDrainsQueue`, `app.Run` |
| Restart | Devices are marked offline (their connections are gone), and last sequence numbers are reloaded so the duplicate filter survives. | `store.MarkAllOffline`, `LastSeqs` |
| Device reconnects with the same client id (session takeover) | Connections are counted per device, so the old connection closing does not flash the device offline. | `Hook.OnDisconnect` |
| Disk fills up | Readings older than 72 h are pruned every minute (`PULSE_RETENTION_HOURS`). | `app.pruneLoop` |

## Rules engine

| Failure | Behaviour | Where |
|---|---|---|
| A value hovers around the limit | Hysteresis: it fires above the trigger and clears only below a lower clear value, so there is no alert flapping. | `hoveringNearTheLimitDoesNotFlap` |
| A one-sample spike | `forMillis` hold: the condition must persist (for example 3 s) before firing. | `aBriefSpikeDoesNotFire` |
| Out-of-order readings | Skipped for evaluation and counted, so they cannot corrupt the window or the timers. They still count as proof the device is alive. | `outOfOrderReadingsAreSkippedNotEvaluated` |
| Backlog replayed after an outage | Durations use **event time** (reading timestamps), so a replay produces the same alerts that live traffic would have. | `AlertEngine` |
| Device stops sending | A sweep every second fires `device-silent` after 15 s, using the local clock so cross-host clock drift is irrelevant. | `silenceFiresOnSweepAndClearsWhenDataReturns` |
| Many threads, many devices | Per-device locks: one noisy device never blocks the others. Exactly one alert per device and rule under contention. | `concurrentDevicesProduceExactlyOneAlertEach` |
| Broker down | Paho reconnects automatically, and the first connect retries until the broker appears. Alerts raised while disconnected are kept in the store (visible over REST), and the publish failure is counted. Health turns DOWN. | `MqttBridge` |
| Double acknowledgement (two operators click at once) | Idempotent: the first acknowledgement wins, and no second event is emitted. | `acknowledgeIsIdempotent` |
| Memory growth | Resolved alerts are capped (500, oldest evicted). Firing alerts are always kept. | `storeEvictsOldestResolvedButKeepsFiring` |

## Gateway and dashboard

| Failure | Behaviour | Where |
|---|---|---|
| Slow browser (hotel Wi-Fi) | Per-client buffer check. Above 256 KB, readings are shed (the next one supersedes them anyway) but alerts still go through. Above 4 MB, the client is closed with code 1013 and resyncs on reconnect. | `hub.test.ts` |
| An internal service hangs | Every upstream call has a 3 s deadline and maps to 502 or 504, so one slow service cannot exhaust the gateway. | `upstream.ts` |
| Password guessing | Five failures in 5 minutes locks that IP. scrypt hashing with constant-time compare, and unknown users still pay the hash cost (no username enumeration). | `server.test.ts` |
| Token forgery | HS256 only, with issuer, audience and expiry all checked. `alg=none` and foreign-key tokens are rejected. | `auth.test.ts` |
| A client tries to ack as someone else | The acknowledging identity comes from the verified token, never from the request body. | `takes the acknowledging user from the token` |
| WebSocket disconnect | The client reconnects with jittered backoff, then takes a fresh REST snapshot. Events that arrive during the snapshot are held and replayed, and the reducer drops anything already present. | `useLive.ts`, `store.test.ts` |
| Tokens in logs | WebSocket auth happens in the first message (not the URL), and the logger redacts `authorization` and `password`. | `server.ts` |

## Known gaps (deliberate, for later phases)

- **Single ingest instance.** SQLite and the embedded broker make Phase 1 easy to run but cap it
  to one node. Scaling out means an external broker cluster (EMQX or VerneMQ), Postgres or
  TimescaleDB, and shared subscriptions for the rules engine.
- **Alert state is in memory.** A rules-engine restart forgets history and re-fires anything
  still wrong. That is safe (no missed alerts) but noisy. Fix: persist to Postgres.
- **Shared device token.** One leaked token lets an attacker connect as *any* device id. Phase 4
  replaces it with per-device mTLS certificates.
- **No TLS in local dev.** Production would terminate TLS at the edge for MQTT (8883) and HTTPS.
- **Gateway rate limiting is per instance.** Multiple gateways need a shared store such as Redis.
