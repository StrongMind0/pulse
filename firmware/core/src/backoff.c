#include "pulse/backoff.h"

void backoff_init(backoff *b, uint32_t base_ms, uint32_t max_ms)
{
    b->base_ms = base_ms;
    b->max_ms = max_ms;
    b->attempt = 0;
}

uint32_t backoff_ceiling(const backoff *b)
{
    uint64_t c = b->base_ms;
    uint32_t i;
    for (i = 0; i < b->attempt && c < b->max_ms; i++) {
        c *= 2u; /* loop instead of a shift so large attempts cannot overflow */
    }
    return c > b->max_ms ? b->max_ms : (uint32_t)c;
}

uint32_t backoff_next(backoff *b, double r)
{
    uint32_t ceiling = backoff_ceiling(b);
    if (r < 0.0) {
        r = 0.0;
    }
    if (r >= 1.0) {
        r = 0.999999;
    }
    if (b->attempt < 32u) {
        b->attempt++;
    }
    /* never 0: always yield at least base/2 so a tight loop cannot spin */
    {
        uint32_t d = (uint32_t)(r * (double)ceiling);
        uint32_t floor_ms = b->base_ms / 2u;
        return d < floor_ms ? floor_ms : d;
    }
}

void backoff_reset(backoff *b)
{
    b->attempt = 0;
}
