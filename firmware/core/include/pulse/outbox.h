/*
 * Outbox: a fixed-capacity FIFO of telemetry messages that have not yet been
 * acknowledged by the broker (QoS 1 PUBACK).
 *
 * - Messages survive disconnects and are retransmitted (with DUP set) after
 *   reconnecting, so a flaky Wi-Fi link does not lose data.
 * - Memory is bounded. When the outbox is full the OLDEST message is dropped:
 *   for live telemetry the newest reading is the most valuable one.
 * - Messages are acknowledged out of order, but released strictly in order
 *   from the head, so the FIFO never fragments.
 */
#ifndef PULSE_OUTBOX_H
#define PULSE_OUTBOX_H

#include <stddef.h>
#include <stdint.h>

#ifndef OUTBOX_CAPACITY
#define OUTBOX_CAPACITY 64
#endif
#ifndef OUTBOX_PAYLOAD_MAX
#define OUTBOX_PAYLOAD_MAX 256
#endif

enum outbox_state { OUTBOX_QUEUED = 0, OUTBOX_INFLIGHT = 1, OUTBOX_ACKED = 2 };

typedef struct {
    int64_t seq;
    uint16_t packet_id;
    uint8_t state;
    uint8_t dup;
    uint64_t sent_at_ms;
    size_t len;
    uint8_t payload[OUTBOX_PAYLOAD_MAX];
} outbox_msg;

typedef struct {
    outbox_msg items[OUTBOX_CAPACITY];
    size_t head;
    size_t count;
    uint16_t next_packet_id;
    uint32_t dropped; /* lifetime count of messages lost to overflow */
} outbox;

void outbox_init(outbox *ob);

/* Returns 0 if queued, 1 if the oldest message was evicted to make room,
 * -1 if the payload is too large. */
int outbox_push(outbox *ob, int64_t seq, const uint8_t *payload, size_t len);

/* Picks the next message to (re)transmit: a queued message, or an in-flight
 * one whose ack timed out. At most `window` messages are in flight at once.
 * Returns NULL if there is nothing to send right now. */
outbox_msg *outbox_next(outbox *ob, uint64_t now_ms, uint32_t retry_ms, size_t window);

/* Assigns a packet id (non-zero, wrapping) and marks the message in flight. */
void outbox_mark_sent(outbox *ob, outbox_msg *m, uint64_t now_ms);

/* Handles a PUBACK. Returns 1 if it matched an in-flight message. */
int outbox_ack(outbox *ob, uint16_t packet_id);

/* After a reconnect every in-flight message must be resent with DUP set
 * [MQTT-4.4.0-1]. */
void outbox_requeue_inflight(outbox *ob);

size_t outbox_count(const outbox *ob);
size_t outbox_inflight(const outbox *ob);

#endif
