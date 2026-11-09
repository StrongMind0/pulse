#include "pulse/outbox.h"

#include <string.h>

static outbox_msg *at(outbox *ob, size_t i)
{
    return &ob->items[(ob->head + i) % OUTBOX_CAPACITY];
}

void outbox_init(outbox *ob)
{
    memset(ob, 0, sizeof *ob);
    ob->next_packet_id = 1;
}

static void pop_head(outbox *ob)
{
    ob->head = (ob->head + 1) % OUTBOX_CAPACITY;
    ob->count--;
}

int outbox_push(outbox *ob, int64_t seq, const uint8_t *payload, size_t len)
{
    int evicted = 0;
    outbox_msg *m;
    if (len > OUTBOX_PAYLOAD_MAX) {
        return -1;
    }
    if (ob->count == OUTBOX_CAPACITY) {
        pop_head(ob);
        ob->dropped++;
        evicted = 1;
    }
    m = at(ob, ob->count);
    memset(m, 0, sizeof *m);
    m->seq = seq;
    m->state = OUTBOX_QUEUED;
    m->len = len;
    memcpy(m->payload, payload, len);
    ob->count++;
    return evicted;
}

outbox_msg *outbox_next(outbox *ob, uint64_t now_ms, uint32_t retry_ms, size_t window)
{
    size_t i;
    size_t inflight = outbox_inflight(ob);
    for (i = 0; i < ob->count; i++) {
        outbox_msg *m = at(ob, i);
        if (m->state == OUTBOX_INFLIGHT && now_ms - m->sent_at_ms >= retry_ms) {
            m->dup = 1;
            return m; /* timed-out message is retried before new ones */
        }
    }
    if (inflight >= window) {
        return NULL;
    }
    for (i = 0; i < ob->count; i++) {
        outbox_msg *m = at(ob, i);
        if (m->state == OUTBOX_QUEUED) {
            return m;
        }
    }
    return NULL;
}

void outbox_mark_sent(outbox *ob, outbox_msg *m, uint64_t now_ms)
{
    if (m->packet_id == 0) {
        m->packet_id = ob->next_packet_id;
        ob->next_packet_id = (uint16_t)(ob->next_packet_id + 1);
        if (ob->next_packet_id == 0) {
            ob->next_packet_id = 1;
        }
    }
    m->state = OUTBOX_INFLIGHT;
    m->sent_at_ms = now_ms;
}

int outbox_ack(outbox *ob, uint16_t packet_id)
{
    size_t i;
    int found = 0;
    for (i = 0; i < ob->count; i++) {
        outbox_msg *m = at(ob, i);
        if (m->state == OUTBOX_INFLIGHT && m->packet_id == packet_id) {
            m->state = OUTBOX_ACKED;
            found = 1;
            break;
        }
    }
    while (ob->count > 0 && at(ob, 0)->state == OUTBOX_ACKED) {
        pop_head(ob);
    }
    return found;
}

void outbox_requeue_inflight(outbox *ob)
{
    size_t i;
    for (i = 0; i < ob->count; i++) {
        outbox_msg *m = at(ob, i);
        if (m->state == OUTBOX_INFLIGHT) {
            m->state = OUTBOX_QUEUED;
            m->dup = 1; /* keep packet_id: same message, new attempt */
        }
    }
}

size_t outbox_count(const outbox *ob)
{
    return ob->count;
}

size_t outbox_inflight(const outbox *ob)
{
    size_t i, n = 0;
    for (i = 0; i < ob->count; i++) {
        if (ob->items[(ob->head + i) % OUTBOX_CAPACITY].state == OUTBOX_INFLIGHT) {
            n++;
        }
    }
    return n;
}
