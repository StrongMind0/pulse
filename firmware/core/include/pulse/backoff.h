/*
 * Reconnect backoff: exponential with full jitter.
 *
 * Without jitter, every device in a building reconnects in lockstep after a
 * broker restart and knocks it over again (thundering herd). Full jitter
 * spreads them uniformly across the window.
 */
#ifndef PULSE_BACKOFF_H
#define PULSE_BACKOFF_H

#include <stdint.h>

typedef struct {
    uint32_t base_ms;
    uint32_t max_ms;
    uint32_t attempt;
} backoff;

void backoff_init(backoff *b, uint32_t base_ms, uint32_t max_ms);

/* Upper bound of the window for the current attempt: min(max, base * 2^attempt). */
uint32_t backoff_ceiling(const backoff *b);

/* Next delay given a uniform random value r in [0,1). Advances the attempt. */
uint32_t backoff_next(backoff *b, double r);

void backoff_reset(backoff *b);

#endif
