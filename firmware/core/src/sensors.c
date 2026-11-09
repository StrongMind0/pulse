#include "pulse/sensors.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#define PI 3.14159265358979323846

uint32_t sensor_hash(const char *s)
{
    uint32_t h = 2166136261u; /* FNV-1a */
    while (*s) {
        h ^= (uint8_t)*s++;
        h *= 16777619u;
    }
    return h ? h : 1u;
}

static uint32_t xorshift32(uint32_t *state)
{
    uint32_t x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    return x;
}

double sensor_rand(sensor_model *m)
{
    return (double)xorshift32(&m->rng) / 4294967296.0;
}

/* Approximately normal noise (Irwin-Hall, sum of 4 uniforms). */
static double noise(sensor_model *m, double sigma)
{
    double s = sensor_rand(m) + sensor_rand(m) + sensor_rand(m) + sensor_rand(m);
    return (s - 2.0) * sigma * 1.732;
}

void sensor_init(sensor_model *m, enum sensor_kind kind, const char *device_id)
{
    memset(m, 0, sizeof *m);
    m->kind = kind;
    m->rng = sensor_hash(device_id);
    m->temp_bias = (sensor_rand(m) - 0.5) * 6.0; /* each unit runs a bit warmer or cooler */
    sensor_step(m, 0.0);
}

void sensor_set_fault(sensor_model *m, enum sensor_fault f)
{
    m->fault = f;
    m->fault_age = 0.0;
}

const char *sensor_fault_name(enum sensor_fault f)
{
    switch (f) {
    case FAULT_OVERHEAT: return "overheat";
    case FAULT_VIBRATION: return "vibration";
    case FAULT_STUCK: return "stuck";
    case FAULT_SILENT: return "silent";
    default: return "none";
    }
}

static void set(sensor_model *m, size_t i, const char *name, double v)
{
    m->metrics[i].name = name;
    m->metrics[i].value = v;
}

void sensor_step(sensor_model *m, double dt)
{
    double daily, temp, vib;
    m->t += dt;
    if (m->fault != FAULT_NONE) {
        m->fault_age += dt;
    }
    if (m->fault == FAULT_STUCK && m->n > 0) {
        return; /* frozen sensor repeats its last values exactly */
    }

    daily = sin(2.0 * PI * m->t / 600.0); /* a compressed "day" every 10 minutes */
    vib = 0.02 + fabs(noise(m, 0.006));
    if (m->fault == FAULT_VIBRATION) {
        vib += 0.4 + 0.2 * sensor_rand(m);
    }

    switch (m->kind) {
    case KIND_PUMP:
        temp = 48.0 + m->temp_bias + 3.0 * daily + noise(m, 0.4);
        if (m->fault == FAULT_OVERHEAT) {
            temp += 1.5 * m->fault_age; /* +1.5 C per second until it trips */
        }
        m->n = 3;
        set(m, 0, "temperature_c", temp);
        set(m, 1, "pressure_bar", 4.2 + 0.3 * daily + noise(m, 0.05));
        set(m, 2, "vibration_g", vib);
        break;
    case KIND_MOTOR:
        temp = 62.0 + m->temp_bias + 4.0 * daily + noise(m, 0.5);
        if (m->fault == FAULT_OVERHEAT) {
            temp += 1.5 * m->fault_age;
        }
        m->n = 3;
        set(m, 0, "temperature_c", temp);
        set(m, 1, "current_a", 12.0 + 1.5 * daily + noise(m, 0.3));
        set(m, 2, "vibration_g", vib);
        break;
    case KIND_ENV:
    default:
        temp = 22.0 + m->temp_bias * 0.3 + 2.0 * daily + noise(m, 0.15);
        if (m->fault == FAULT_OVERHEAT) {
            temp += 0.8 * m->fault_age;
        }
        m->n = 2;
        set(m, 0, "temperature_c", temp);
        set(m, 1, "humidity_pct", 45.0 - 8.0 * daily + noise(m, 0.8));
        break;
    }
}

int sensor_format_payload(const sensor_model *m, int64_t seq, int64_t ts_ms, char *out, size_t cap)
{
    size_t i;
    int n = snprintf(out, cap, "{\"seq\":%lld,\"ts\":%lld,\"metrics\":{", (long long)seq, (long long)ts_ms);
    size_t pos;
    if (n < 0 || (size_t)n >= cap) {
        return -1;
    }
    pos = (size_t)n;
    for (i = 0; i < m->n; i++) {
        n = snprintf(out + pos, cap - pos, "%s\"%s\":%.3f", i ? "," : "", m->metrics[i].name, m->metrics[i].value);
        if (n < 0 || (size_t)n >= cap - pos) {
            return -1;
        }
        pos += (size_t)n;
    }
    n = snprintf(out + pos, cap - pos, "}}");
    if (n < 0 || (size_t)n >= cap - pos) {
        return -1;
    }
    return (int)(pos + (size_t)n);
}
