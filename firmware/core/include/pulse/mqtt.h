/*
 * Minimal MQTT 3.1.1 client codec: exactly what a telemetry device needs and
 * nothing more. Encoding writes into caller-provided buffers; decoding reads
 * from a byte stream. No heap, no I/O: the same code runs on an ESP32 and in
 * the host simulator, and is unit tested on its own.
 */
#ifndef PULSE_MQTT_H
#define PULSE_MQTT_H

#include <stddef.h>
#include <stdint.h>

enum mqtt_type {
    MQTT_CONNECT = 1,
    MQTT_CONNACK = 2,
    MQTT_PUBLISH = 3,
    MQTT_PUBACK = 4,
    MQTT_PINGREQ = 12,
    MQTT_PINGRESP = 13,
    MQTT_DISCONNECT = 14
};

enum mqtt_connack_rc {
    MQTT_CONNACK_ACCEPTED = 0,
    MQTT_CONNACK_BAD_PROTOCOL = 1,
    MQTT_CONNACK_ID_REJECTED = 2,
    MQTT_CONNACK_UNAVAILABLE = 3,
    MQTT_CONNACK_BAD_CREDENTIALS = 4,
    MQTT_CONNACK_NOT_AUTHORIZED = 5
};

/* Negative return codes from the codec. */
#define MQTT_ERR_BUFFER   (-1) /* output buffer too small */
#define MQTT_ERR_INCOMPLETE (-2) /* need more input bytes */
#define MQTT_ERR_MALFORMED (-3) /* protocol violation in input */
#define MQTT_ERR_ARG      (-4) /* invalid argument (e.g. string > 65535) */

#define MQTT_MAX_REMAINING 268435455u

typedef struct {
    const char *client_id;
    const char *username; /* may be NULL */
    const char *password; /* may be NULL */
    uint16_t keepalive_s;
    int clean_session;
} mqtt_connect_opts;

typedef struct {
    uint8_t type;   /* enum mqtt_type */
    uint8_t flags;  /* low nibble of the fixed header */
    uint16_t packet_id;   /* PUBACK */
    uint8_t connack_rc;   /* CONNACK */
    uint8_t session_present; /* CONNACK */
    size_t length;  /* total bytes consumed for this packet */
} mqtt_packet;

/* Variable-length "remaining length" field. Returns bytes written or error. */
int mqtt_encode_remaining(uint8_t *out, size_t cap, uint32_t value);
/* Returns bytes read (1-4) and stores the value, or an error. */
int mqtt_decode_remaining(const uint8_t *in, size_t len, uint32_t *value);

int mqtt_encode_connect(uint8_t *out, size_t cap, const mqtt_connect_opts *o);
int mqtt_encode_publish(uint8_t *out, size_t cap, const char *topic,
                        const uint8_t *payload, size_t payload_len,
                        uint8_t qos, uint16_t packet_id, int dup);
int mqtt_encode_pingreq(uint8_t *out, size_t cap);
int mqtt_encode_disconnect(uint8_t *out, size_t cap);

/*
 * Parse one packet from the front of a receive buffer. On success returns 0
 * and fills *pkt (pkt->length tells the caller how many bytes to discard).
 * Returns MQTT_ERR_INCOMPLETE when more bytes are needed.
 */
int mqtt_decode(const uint8_t *in, size_t len, mqtt_packet *pkt);

#endif
