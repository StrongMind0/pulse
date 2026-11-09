# Architecture decision records

Short records of decisions that were not obvious, with the alternatives considered.

## ADR-001: The MQTT broker is embedded in the ingest service

**Context.** Devices speak MQTT. A standalone broker (Mosquitto, EMQX) is the usual choice.

**Decision.** Embed a broker (mochi-mqtt) in the Go ingest service for Phase 1.

**Why.** Validation, auth and ACLs run *inside* the broker's publish path, so invalid or spoofed
data never reaches a topic anyone can read, and backpressure can be applied by withholding the
PUBACK. It also means one fewer process to run locally.

**Cost.** One ingest node. Scaling out means moving to a clustered broker and running the same
validation as a consumer. The `broker.Hook` boundary keeps that change contained.

## ADR-002: Announce readings after commit, not on receipt

**Decision.** Downstream consumers see a reading only after its batch is committed.

**Why.** Otherwise a reading could raise an alert, then be lost by a failed write: the alert
would reference data that does not exist. **Cost:** up to one flush interval (250 ms) of extra
latency.

## ADR-003: Load shedding by withholding PUBACK

**Decision.** When the ingest queue is full, do not acknowledge QoS 1 messages.

**Alternatives.** Block the broker goroutine (stalls every device on that connection handler);
drop and ack (silent data loss).

**Why.** The device keeps the message in its outbox and retries after its ack timeout. The
buffer moves to the edge, where it already exists, and nothing is lost until the device's own
outbox overflows, which it counts.

## ADR-004: Event time for rule durations

**Decision.** "Held for 3 seconds" is measured with reading timestamps, not the wall clock.

**Why.** After an outage, a backlog arrives in a burst. Wall-clock timing would see 60 seconds
of overheating arrive in 200 ms and never satisfy the hold. Event time gives the same answer
live or replayed. Silence detection is the exception: by definition it has no events, so it
uses the local clock.

## ADR-005: WebSocket authentication in the first message

**Alternatives.** Token in the query string (leaks into access logs and browser history);
cookies (needs CSRF protection and a shared domain); the `Sec-WebSocket-Protocol` header hack.

**Decision.** The client sends `{type:"auth", token}` as its first frame. The server closes the
socket with 4401 if it doesn't arrive within 5 s or is invalid, and nothing is streamed before
that.

## ADR-006: One language per job

| Service | Language | Reason |
|---|---|---|
| Firmware | C | Runs on a microcontroller with kilobytes of RAM and no allocator worth trusting |
| Ingest | Go | Cheap goroutines for thousands of connections, a static binary, a strong standard library for networking |
| Rules | Java | Rich domain modelling (sealed types, records), mature concurrency primitives, Spring's operational tooling (health, metrics, config validation) |
| Gateway | TypeScript | Shares types with the dashboard, and Node's event loop suits fan-out I/O |
| Dashboard | React and Next.js | Component model for a dense live UI, static prerendering of the shell |
