/*
 * Deterministic sensor model. Each device kind produces plausible readings
 * (slow drift + noise) and can enter a fault mode, so the rules engine and
 * dashboard have real incidents to detect during a demo.
 *
 * The PRNG is seeded from the device id: the same device behaves the same way
 * on every run, which makes bugs reproducible.
 */
#ifndef PULSE_SENSORS_H
#define PULSE_SENSORS_H

#include <stddef.h>
#include <stdint.h>

enum sensor_kind { KIND_PUMP = 0, KIND_ENV = 1, KIND_MOTOR = 2 };

enum sensor_fault {
    FAULT_NONE = 0,
    FAULT_OVERHEAT,  /* temperature ramps up steadily */
    FAULT_VIBRATION, /* vibration spikes (bearing failure) */
    FAULT_STUCK,     /* sensor freezes at its last value */
    FAULT_SILENT     /* device stops sending entirely */
};

#define SENSOR_MAX_METRICS 4

typedef struct {
    const char *name;
    double value;
} sensor_metric;

typedef struct {
    enum sensor_kind kind;
    uint32_t rng;
    double t;       /* seconds of simulated time */
    double temp_bias;
    enum sensor_fault fault;
    double fault_age;
    size_t n;
    sensor_metric metrics[SENSOR_MAX_METRICS];
} sensor_model;

uint32_t sensor_hash(const char *s);
void sensor_init(sensor_model *m, enum sensor_kind kind, const char *device_id);

/* Advance the model by dt seconds and refresh m->metrics. */
void sensor_step(sensor_model *m, double dt);

void sensor_set_fault(sensor_model *m, enum sensor_fault f);
const char *sensor_fault_name(enum sensor_fault f);

/* Random number in [0,1) from the model's own stream. */
double sensor_rand(sensor_model *m);

/*
 * Format a telemetry payload: {"boot":B,"seq":N,"ts":MS,"metrics":{...}}
 * `boot` is a random id chosen at power-on; seq restarts at 1 after every
 * boot, so the server needs both to tell a reboot from a retransmission.
 * Returns bytes written (excluding NUL) or -1 if cap is too small.
 */
int sensor_format_payload(const sensor_model *m, uint32_t boot, int64_t seq, int64_t ts_ms, char *out, size_t cap);

#endif
