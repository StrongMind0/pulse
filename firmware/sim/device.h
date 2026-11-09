#ifndef PULSE_DEVICE_H
#define PULSE_DEVICE_H

#include <stdint.h>

#include "platform.h"
#include "pulse/backoff.h"
#include "pulse/outbox.h"
#include "pulse/sensors.h"

typedef struct {
    const char *host;
    uint16_t port;
    const char *token;
    uint32_t interval_ms;
    uint16_t keepalive_s;
    double fault_rate;   /* probability per sample that a healthy device develops a fault */
    double net_chaos;    /* probability per sample that the link is cut */
    int verbose;
} sim_config;

enum dev_state { DEV_DISCONNECTED = 0, DEV_AWAIT_CONNACK, DEV_CONNECTED };

typedef struct {
    char id[64];
    char topic[128];
    sensor_model sensor;
    outbox ob;
    backoff bo;
    sock_t sock;
    enum dev_state state;
    int64_t seq;
    uint32_t boot_id; /* random per power-on; on an ESP32 this is esp_random() */
    uint32_t rng; /* separate from the sensor's stream so network chaos
                     never changes the sensor values a device produces */

    uint64_t next_connect_at;
    uint64_t connack_deadline;
    uint64_t next_sample_at;
    uint64_t last_tx_at;
    uint64_t ping_deadline; /* 0 when no PINGREQ outstanding */
    double fault_until_s;

    uint8_t rx[512];
    size_t rx_len;

    /* counters for the periodic stats line */
    uint32_t published;
    uint32_t acked;
    uint32_t reconnects;
    uint32_t auth_failures;
} device;

void device_init(device *d, const char *id, enum sensor_kind kind, uint64_t now);
void device_tick(device *d, const sim_config *cfg, uint64_t now);
void device_shutdown(device *d);

#endif
