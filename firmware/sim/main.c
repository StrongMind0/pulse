/*
 * pulse-sim: simulates a fleet of telemetry devices on one thread.
 *
 *   pulse-sim --devices 6 --interval-ms 1000 --chaos
 *
 * Each device runs the same core code as the ESP32 firmware: MQTT 3.1.1 with
 * QoS 1, an offline outbox, jittered reconnect backoff and keepalive.
 */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "device.h"
#include "platform.h"

#define MAX_DEVICES 256

static volatile sig_atomic_t g_stop = 0;

static void on_signal(int sig)
{
    (void)sig;
    g_stop = 1;
}

static void usage(void)
{
    printf("usage: pulse-sim [options]\n"
           "  --host HOST         broker host (default 127.0.0.1)\n"
           "  --port N            broker port (default 1883)\n"
           "  --devices N         number of devices, 1-%d (default 6)\n"
           "  --interval-ms N     sample interval (default 1000)\n"
           "  --token T           device token (default $PULSE_DEVICE_TOKEN)\n"
           "  --chaos             inject sensor faults (overheat, vibration, stuck, silent)\n"
           "  --fault-rate P      per-sample fault probability with --chaos (default 0.004)\n"
           "  --net-chaos P       per-sample probability of cutting the link (default 0)\n"
           "  --duration-s N      stop after N seconds (default: run until Ctrl+C)\n"
           "  --verbose           log outbox evictions\n",
           MAX_DEVICES);
}

static const char *kind_name(enum sensor_kind k)
{
    return k == KIND_PUMP ? "pump" : k == KIND_MOTOR ? "motor" : "env";
}

int main(int argc, char **argv)
{
    sim_config cfg;
    static device fleet[MAX_DEVICES];
    int ndev = 6, chaos = 0, i;
    double fault_rate = 0.004;
    long duration_s = 0;
    uint64_t start, last_stats;

    memset(&cfg, 0, sizeof cfg);
    cfg.host = "127.0.0.1";
    cfg.port = 1883;
    cfg.token = getenv("PULSE_DEVICE_TOKEN");
    cfg.interval_ms = 1000;
    cfg.keepalive_s = 30;

    for (i = 1; i < argc; i++) {
        const char *a = argv[i];
        const char *v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!strcmp(a, "--help") || !strcmp(a, "-h")) { usage(); return 0; }
        else if (!strcmp(a, "--chaos")) { chaos = 1; }
        else if (!strcmp(a, "--verbose")) { cfg.verbose = 1; }
        else if (!v) { fprintf(stderr, "missing value for %s\n", a); return 2; }
        else if (!strcmp(a, "--host")) { cfg.host = v; i++; }
        else if (!strcmp(a, "--port")) { cfg.port = (uint16_t)atoi(v); i++; }
        else if (!strcmp(a, "--devices")) { ndev = atoi(v); i++; }
        else if (!strcmp(a, "--interval-ms")) { cfg.interval_ms = (uint32_t)atoi(v); i++; }
        else if (!strcmp(a, "--token")) { cfg.token = v; i++; }
        else if (!strcmp(a, "--fault-rate")) { fault_rate = atof(v); i++; }
        else if (!strcmp(a, "--net-chaos")) { cfg.net_chaos = atof(v); i++; }
        else if (!strcmp(a, "--duration-s")) { duration_s = atol(v); i++; }
        else { fprintf(stderr, "unknown option %s\n", a); usage(); return 2; }
    }
    if (ndev < 1 || ndev > MAX_DEVICES || cfg.interval_ms < 50) {
        fprintf(stderr, "devices must be 1-%d and interval >= 50ms\n", MAX_DEVICES);
        return 2;
    }
    if (!cfg.token || !*cfg.token) {
        fprintf(stderr, "no device token: pass --token or set PULSE_DEVICE_TOKEN\n");
        return 2;
    }
    cfg.fault_rate = chaos ? fault_rate : 0.0;

    if (plat_init() != 0) {
        fprintf(stderr, "network init failed\n");
        return 1;
    }
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    start = plat_now_ms();
    for (i = 0; i < ndev; i++) {
        char id[32];
        enum sensor_kind k = (enum sensor_kind)(i % 3);
        snprintf(id, sizeof id, "%s-%02d", kind_name(k), i + 1);
        device_init(&fleet[i], id, k, start);
    }
    printf("pulse-sim: %d devices -> %s:%u every %ums%s\n", ndev, cfg.host, cfg.port,
           cfg.interval_ms, chaos ? " (chaos on)" : "");
    fflush(stdout);

    last_stats = start;
    while (!g_stop) {
        uint64_t now = plat_now_ms();
        for (i = 0; i < ndev; i++) {
            device_tick(&fleet[i], &cfg, now);
        }
        if (now - last_stats >= 10000u) {
            uint32_t pub = 0, ack = 0, lost = 0, connected = 0;
            size_t buffered = 0;
            for (i = 0; i < ndev; i++) {
                pub += fleet[i].published;
                ack += fleet[i].acked;
                lost += fleet[i].ob.dropped;
                buffered += outbox_count(&fleet[i].ob);
                connected += fleet[i].state == DEV_CONNECTED;
            }
            printf("[stats    ] connected=%u/%d published=%u acked=%u buffered=%u lost=%u\n",
                   connected, ndev, pub, ack, (unsigned)buffered, lost);
            fflush(stdout);
            last_stats = now;
        }
        if (duration_s > 0 && now - start >= (uint64_t)duration_s * 1000u) {
            break;
        }
        plat_sleep_ms(10);
    }

    for (i = 0; i < ndev; i++) {
        device_shutdown(&fleet[i]);
    }
    plat_cleanup();
    printf("pulse-sim: stopped\n");
    return 0;
}
