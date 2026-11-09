#include "pulse/mqtt.h"

#include <string.h>

int mqtt_encode_remaining(uint8_t *out, size_t cap, uint32_t value)
{
    int n = 0;
    if (value > MQTT_MAX_REMAINING) {
        return MQTT_ERR_ARG;
    }
    do {
        uint8_t byte = (uint8_t)(value % 128u);
        value /= 128u;
        if (value > 0) {
            byte |= 0x80u;
        }
        if ((size_t)n >= cap) {
            return MQTT_ERR_BUFFER;
        }
        out[n++] = byte;
    } while (value > 0);
    return n;
}

int mqtt_decode_remaining(const uint8_t *in, size_t len, uint32_t *value)
{
    uint32_t multiplier = 1;
    uint32_t v = 0;
    size_t i;
    for (i = 0; i < 4; i++) {
        if (i >= len) {
            return MQTT_ERR_INCOMPLETE;
        }
        v += (uint32_t)(in[i] & 0x7Fu) * multiplier;
        if ((in[i] & 0x80u) == 0) {
            *value = v;
            return (int)(i + 1);
        }
        multiplier *= 128u;
    }
    return MQTT_ERR_MALFORMED; /* a 5th continuation byte is illegal */
}

/* Writer that tracks overflow so encoders stay linear and readable. */
typedef struct {
    uint8_t *buf;
    size_t cap;
    size_t pos;
    int overflow;
} writer;

static void w_u8(writer *w, uint8_t b)
{
    if (w->pos >= w->cap) {
        w->overflow = 1;
        return;
    }
    w->buf[w->pos++] = b;
}

static void w_u16(writer *w, uint16_t v)
{
    w_u8(w, (uint8_t)(v >> 8));
    w_u8(w, (uint8_t)(v & 0xFFu));
}

static void w_bytes(writer *w, const uint8_t *p, size_t n)
{
    if (n > w->cap - w->pos || w->pos > w->cap) {
        w->overflow = 1;
        return;
    }
    memcpy(w->buf + w->pos, p, n);
    w->pos += n;
}

static void w_str(writer *w, const char *s)
{
    size_t n = strlen(s);
    w_u16(w, (uint16_t)n);
    w_bytes(w, (const uint8_t *)s, n);
}

static int finish(writer *w)
{
    return w->overflow ? MQTT_ERR_BUFFER : (int)w->pos;
}

static void w_header(writer *w, uint8_t first, uint32_t remaining)
{
    uint8_t rl[4];
    int n = mqtt_encode_remaining(rl, sizeof rl, remaining);
    w_u8(w, first);
    if (n < 0) {
        w->overflow = 1;
        return;
    }
    w_bytes(w, rl, (size_t)n);
}

int mqtt_encode_connect(uint8_t *out, size_t cap, const mqtt_connect_opts *o)
{
    writer w = {out, cap, 0, 0};
    uint8_t flags = 0;
    size_t remaining = 10 + 2 + strlen(o->client_id);

    if (strlen(o->client_id) > 65535u) {
        return MQTT_ERR_ARG;
    }
    if (o->username) {
        flags |= 0x80u;
        remaining += 2 + strlen(o->username);
    }
    if (o->password) {
        if (!o->username) {
            return MQTT_ERR_ARG; /* [MQTT-3.1.2-22] password requires username */
        }
        flags |= 0x40u;
        remaining += 2 + strlen(o->password);
    }
    if (o->clean_session) {
        flags |= 0x02u;
    }

    w_header(&w, (uint8_t)(MQTT_CONNECT << 4), (uint32_t)remaining);
    w_str(&w, "MQTT");
    w_u8(&w, 4); /* protocol level 3.1.1 */
    w_u8(&w, flags);
    w_u16(&w, o->keepalive_s);
    w_str(&w, o->client_id);
    if (o->username) {
        w_str(&w, o->username);
    }
    if (o->password) {
        w_str(&w, o->password);
    }
    return finish(&w);
}

int mqtt_encode_publish(uint8_t *out, size_t cap, const char *topic,
                        const uint8_t *payload, size_t payload_len,
                        uint8_t qos, uint16_t packet_id, int dup)
{
    writer w = {out, cap, 0, 0};
    size_t topic_len = strlen(topic);
    size_t remaining;
    uint8_t first = (uint8_t)(MQTT_PUBLISH << 4);

    if (qos > 1 || topic_len == 0 || topic_len > 65535u) {
        return MQTT_ERR_ARG; /* QoS 2 is deliberately unsupported */
    }
    if (qos == 1 && packet_id == 0) {
        return MQTT_ERR_ARG; /* [MQTT-2.3.1-1] packet id must be non-zero */
    }
    remaining = 2 + topic_len + (qos ? 2u : 0u) + payload_len;
    if (remaining > MQTT_MAX_REMAINING) {
        return MQTT_ERR_ARG;
    }
    first |= (uint8_t)(qos << 1);
    if (dup && qos) {
        first |= 0x08u;
    }
    w_header(&w, first, (uint32_t)remaining);
    w_str(&w, topic);
    if (qos) {
        w_u16(&w, packet_id);
    }
    w_bytes(&w, payload, payload_len);
    return finish(&w);
}

int mqtt_encode_pingreq(uint8_t *out, size_t cap)
{
    writer w = {out, cap, 0, 0};
    w_u8(&w, (uint8_t)(MQTT_PINGREQ << 4));
    w_u8(&w, 0);
    return finish(&w);
}

int mqtt_encode_disconnect(uint8_t *out, size_t cap)
{
    writer w = {out, cap, 0, 0};
    w_u8(&w, (uint8_t)(MQTT_DISCONNECT << 4));
    w_u8(&w, 0);
    return finish(&w);
}

int mqtt_decode(const uint8_t *in, size_t len, mqtt_packet *pkt)
{
    uint32_t remaining = 0;
    int rl_len;
    const uint8_t *body;

    if (len < 2) {
        return MQTT_ERR_INCOMPLETE;
    }
    rl_len = mqtt_decode_remaining(in + 1, len - 1, &remaining);
    if (rl_len < 0) {
        return rl_len;
    }
    if ((size_t)(1 + rl_len) + remaining > len) {
        return MQTT_ERR_INCOMPLETE;
    }

    memset(pkt, 0, sizeof *pkt);
    pkt->type = (uint8_t)(in[0] >> 4);
    pkt->flags = (uint8_t)(in[0] & 0x0Fu);
    pkt->length = (size_t)(1 + rl_len) + remaining;
    body = in + 1 + rl_len;

    switch (pkt->type) {
    case MQTT_CONNACK:
        if (remaining != 2 || pkt->flags != 0) {
            return MQTT_ERR_MALFORMED;
        }
        pkt->session_present = (uint8_t)(body[0] & 0x01u);
        pkt->connack_rc = body[1];
        return 0;
    case MQTT_PUBACK:
        if (remaining != 2 || pkt->flags != 0) {
            return MQTT_ERR_MALFORMED;
        }
        pkt->packet_id = (uint16_t)((body[0] << 8) | body[1]);
        return 0;
    case MQTT_PINGRESP:
        return remaining == 0 ? 0 : MQTT_ERR_MALFORMED;
    default:
        /* Anything else is unexpected for a publish-only device, but it is
         * well-formed framing, so report it and let the caller skip it. */
        return 0;
    }
}
