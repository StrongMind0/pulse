#include "device.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "pulse/mqtt.h"

#define CONNACK_TIMEOUT_MS 5000u
#define ACK_TIMEOUT_MS 5000u
#define INFLIGHT_WINDOW 8u
#define MAX_SENDS_PER_TICK 16

static void logf_dev(const device *d, const char *fmt, ...)
{
    va_list ap;
    printf("[%-9s] ", d->id);
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    printf("\n");
    fflush(stdout);
}

static double rnd(device *d)
{
    uint32_t x = d->rng;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    d->rng = x;
    return (double)x / 4294967296.0;
}

void device_init(device *d, const char *id, enum sensor_kind kind, uint64_t now)
{
    memset(d, 0, sizeof *d);
    snprintf(d->id, sizeof d->id, "%s", id);
    snprintf(d->topic, sizeof d->topic, "pulse/v1/devices/%s/telemetry", id);
    sensor_init(&d->sensor, kind, id);
    outbox_init(&d->ob);
    backoff_init(&d->bo, 500, 30000);
    d->sock = SOCK_INVALID;
    d->state = DEV_DISCONNECTED;
    d->rng = sensor_hash(id) ^ 0x9E3779B9u;
    if (d->rng == 0) {
        d->rng = 1;
    }
    /* stagger first connect and samples so devices don't all fire at once */
    d->next_connect_at = now + (uint64_t)(rnd(d) * 500.0);
    d->next_sample_at = now + (uint64_t)(rnd(d) * 1000.0);
}

static void drop(device *d, uint64_t now, const char *why)
{
    uint32_t delay;
    if (d->sock != SOCK_INVALID) {
        plat_close(d->sock);
    }
    if (d->state == DEV_CONNECTED) {
        logf_dev(d, "disconnected: %s (%u queued)", why, (unsigned)outbox_count(&d->ob));
    }
    d->sock = SOCK_INVALID;
    d->state = DEV_DISCONNECTED;
    d->rx_len = 0;
    d->ping_deadline = 0;
    delay = backoff_next(&d->bo, rnd(d));
    d->next_connect_at = now + delay;
    d->reconnects++;
    if (d->bo.attempt > 1) {
        logf_dev(d, "reconnect in %u ms (attempt %u): %s", delay, d->bo.attempt, why);
    }
}

static int send_bytes(device *d, const uint8_t *buf, int n, uint64_t now)
{
    if (n < 0 || plat_send_all(d->sock, buf, (size_t)n) != 0) {
        drop(d, now, "send failed");
        return -1;
    }
    d->last_tx_at = now;
    return 0;
}

static void start_connect(device *d, const sim_config *cfg, uint64_t now)
{
    uint8_t buf[256];
    mqtt_connect_opts o;
    int n;

    d->sock = plat_connect(cfg->host, cfg->port);
    if (d->sock == SOCK_INVALID) {
        drop(d, now, "broker unreachable");
        return;
    }
    memset(&o, 0, sizeof o);
    o.client_id = d->id;
    o.username = d->id;
    o.password = cfg->token;
    o.keepalive_s = cfg->keepalive_s;
    o.clean_session = 1;
    n = mqtt_encode_connect(buf, sizeof buf, &o);
    d->state = DEV_AWAIT_CONNACK;
    d->connack_deadline = now + CONNACK_TIMEOUT_MS;
    send_bytes(d, buf, n, now);
}

static void sample(device *d, const sim_config *cfg, uint64_t now)
{
    char payload[OUTBOX_PAYLOAD_MAX];
    int n;
    sensor_model *s = &d->sensor;

    sensor_step(s, cfg->interval_ms / 1000.0);

    if (s->fault != FAULT_NONE && s->t >= d->fault_until_s) {
        logf_dev(d, "fault cleared: %s", sensor_fault_name(s->fault));
        sensor_set_fault(s, FAULT_NONE);
    } else if (s->fault == FAULT_NONE && cfg->fault_rate > 0 && rnd(d) < cfg->fault_rate) {
        enum sensor_fault f = (enum sensor_fault)(1 + (int)(rnd(d) * 4.0));
        sensor_set_fault(s, f);
        d->fault_until_s = s->t + 30.0 + rnd(d) * 30.0;
        logf_dev(d, "fault injected: %s for %.0fs", sensor_fault_name(f), d->fault_until_s - s->t);
    }

    if (s->fault == FAULT_SILENT) {
        return; /* hung firmware: connected, but nothing to say */
    }

    d->seq++;
    n = sensor_format_payload(s, d->seq, plat_wall_ms(), payload, sizeof payload);
    if (n < 0) {
        logf_dev(d, "payload too large, skipped seq %lld", (long long)d->seq);
        return;
    }
    if (outbox_push(&d->ob, d->seq, (const uint8_t *)payload, (size_t)n) == 1 && cfg->verbose) {
        logf_dev(d, "outbox full, evicted oldest (total lost %u)", d->ob.dropped);
    }

    if (d->state == DEV_CONNECTED && cfg->net_chaos > 0 && rnd(d) < cfg->net_chaos) {
        drop(d, now, "link cut by chaos monkey");
    }
}

static void handle_packets(device *d, uint64_t now)
{
    for (;;) {
        mqtt_packet p;
        int rc = mqtt_decode(d->rx, d->rx_len, &p);
        if (rc == MQTT_ERR_INCOMPLETE) {
            return;
        }
        if (rc < 0) {
            drop(d, now, "malformed packet from broker");
            return;
        }
        switch (p.type) {
        case MQTT_CONNACK:
            if (p.connack_rc != MQTT_CONNACK_ACCEPTED) {
                d->auth_failures++;
                logf_dev(d, "broker refused connection (rc=%u)", p.connack_rc);
                drop(d, now, "connection refused");
                return;
            }
            d->state = DEV_CONNECTED;
            backoff_reset(&d->bo);
            outbox_requeue_inflight(&d->ob);
            logf_dev(d, "connected (%u buffered to flush)", (unsigned)outbox_count(&d->ob));
            break;
        case MQTT_PUBACK:
            if (outbox_ack(&d->ob, p.packet_id)) {
                d->acked++;
            }
            break;
        case MQTT_PINGRESP:
            d->ping_deadline = 0;
            break;
        default:
            break;
        }
        memmove(d->rx, d->rx + p.length, d->rx_len - p.length);
        d->rx_len -= p.length;
    }
}

static void read_socket(device *d, uint64_t now)
{
    while (d->sock != SOCK_INVALID) {
        int n;
        if (d->rx_len == sizeof d->rx) {
            drop(d, now, "receive buffer overflow");
            return;
        }
        n = plat_recv(d->sock, d->rx + d->rx_len, sizeof d->rx - d->rx_len);
        if (n < 0) {
            drop(d, now, "connection closed by broker");
            return;
        }
        if (n == 0) {
            return;
        }
        d->rx_len += (size_t)n;
        handle_packets(d, now);
    }
}

static void flush_outbox(device *d, uint64_t now)
{
    int i;
    for (i = 0; i < MAX_SENDS_PER_TICK && d->state == DEV_CONNECTED; i++) {
        uint8_t buf[OUTBOX_PAYLOAD_MAX + 160];
        int n;
        outbox_msg *m = outbox_next(&d->ob, now, ACK_TIMEOUT_MS, INFLIGHT_WINDOW);
        if (!m) {
            return;
        }
        outbox_mark_sent(&d->ob, m, now);
        n = mqtt_encode_publish(buf, sizeof buf, d->topic, m->payload, m->len, 1, m->packet_id, m->dup);
        if (send_bytes(d, buf, n, now) == 0) {
            d->published++;
        }
    }
}

static void keepalive(device *d, const sim_config *cfg, uint64_t now)
{
    uint8_t buf[2];
    uint64_t ka = (uint64_t)cfg->keepalive_s * 1000u;
    if (d->ping_deadline && now > d->ping_deadline) {
        drop(d, now, "keepalive timeout");
        return;
    }
    if (!d->ping_deadline && now - d->last_tx_at >= ka / 2u) {
        if (send_bytes(d, buf, mqtt_encode_pingreq(buf, sizeof buf), now) == 0) {
            d->ping_deadline = now + ka;
        }
    }
}

void device_tick(device *d, const sim_config *cfg, uint64_t now)
{
    if (now >= d->next_sample_at) {
        sample(d, cfg, now);
        d->next_sample_at += cfg->interval_ms;
        if (now > d->next_sample_at + 5u * cfg->interval_ms) {
            d->next_sample_at = now + cfg->interval_ms; /* fell far behind: skip, don't burst */
        }
    }

    if (d->state == DEV_DISCONNECTED && now >= d->next_connect_at) {
        start_connect(d, cfg, now);
    }
    if (d->state == DEV_AWAIT_CONNACK && now > d->connack_deadline) {
        drop(d, now, "CONNACK timeout");
    }
    if (d->sock != SOCK_INVALID) {
        read_socket(d, now);
    }
    if (d->state == DEV_CONNECTED) {
        flush_outbox(d, now);
    }
    if (d->state == DEV_CONNECTED) {
        keepalive(d, cfg, now);
    }
}

void device_shutdown(device *d)
{
    if (d->state == DEV_CONNECTED) {
        uint8_t buf[2];
        int n = mqtt_encode_disconnect(buf, sizeof buf);
        if (n > 0) {
            plat_send_all(d->sock, buf, (size_t)n);
        }
    }
    if (d->sock != SOCK_INVALID) {
        plat_close(d->sock);
    }
    d->sock = SOCK_INVALID;
    d->state = DEV_DISCONNECTED;
}
