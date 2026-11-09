/* Unit tests for the portable firmware core. No framework: one file, one
 * binary, non-zero exit on failure, runs anywhere a C compiler does. */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "pulse/backoff.h"
#include "pulse/mqtt.h"
#include "pulse/outbox.h"
#include "pulse/sensors.h"

static int g_failed = 0;
static int g_run = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        g_run++;                                                             \
        if (!(cond)) {                                                       \
            g_failed++;                                                      \
            printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);         \
        }                                                                    \
    } while (0)

#define TEST(name) static void name(void)
#define RUN(name)                      \
    do {                               \
        printf("%s\n", #name);         \
        name();                        \
    } while (0)

TEST(remaining_length_boundaries)
{
    /* Values and encodings from MQTT 3.1.1 spec table 2.4 */
    static const struct { uint32_t v; int n; uint8_t b[4]; } cases[] = {
        {0, 1, {0x00}},
        {127, 1, {0x7F}},
        {128, 2, {0x80, 0x01}},
        {16383, 2, {0xFF, 0x7F}},
        {16384, 3, {0x80, 0x80, 0x01}},
        {2097151, 3, {0xFF, 0xFF, 0x7F}},
        {2097152, 4, {0x80, 0x80, 0x80, 0x01}},
        {268435455, 4, {0xFF, 0xFF, 0xFF, 0x7F}},
    };
    size_t i;
    for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        uint8_t out[4];
        uint32_t back = 0;
        int n = mqtt_encode_remaining(out, sizeof out, cases[i].v);
        CHECK(n == cases[i].n);
        CHECK(memcmp(out, cases[i].b, (size_t)cases[i].n) == 0);
        CHECK(mqtt_decode_remaining(out, (size_t)n, &back) == n);
        CHECK(back == cases[i].v);
    }
    {
        uint8_t out[4];
        uint8_t five[] = {0xFF, 0xFF, 0xFF, 0xFF, 0x01};
        uint32_t v;
        CHECK(mqtt_encode_remaining(out, sizeof out, 268435456u) == MQTT_ERR_ARG);
        CHECK(mqtt_encode_remaining(out, 1, 128) == MQTT_ERR_BUFFER);
        CHECK(mqtt_decode_remaining(five, sizeof five, &v) == MQTT_ERR_MALFORMED);
        CHECK(mqtt_decode_remaining(five, 2, &v) == MQTT_ERR_INCOMPLETE);
    }
}

TEST(connect_packet_bytes)
{
    uint8_t out[64];
    mqtt_connect_opts o = {"d1", "d1", "pw", 30, 1};
    static const uint8_t want[] = {
        0x10, 22,                               /* CONNECT, remaining length */
        0x00, 0x04, 'M', 'Q', 'T', 'T', 0x04,   /* protocol name + level 4 */
        0xC2,                                   /* username|password|clean */
        0x00, 0x1E,                             /* keepalive 30 */
        0x00, 0x02, 'd', '1',                   /* client id */
        0x00, 0x02, 'd', '1',                   /* username */
        0x00, 0x02, 'p', 'w',                   /* password */
    };
    int n = mqtt_encode_connect(out, sizeof out, &o);
    CHECK(n == (int)sizeof want);
    CHECK(memcmp(out, want, sizeof want) == 0);
    CHECK(mqtt_encode_connect(out, 10, &o) == MQTT_ERR_BUFFER);

    o.username = NULL; /* password without username is illegal */
    CHECK(mqtt_encode_connect(out, sizeof out, &o) == MQTT_ERR_ARG);
}

TEST(publish_packet_bytes)
{
    uint8_t out[64];
    const uint8_t payload[] = {'h', 'i'};
    static const uint8_t want_qos1[] = {0x32, 9, 0x00, 0x03, 'a', '/', 'b', 0x12, 0x34, 'h', 'i'};
    int n = mqtt_encode_publish(out, sizeof out, "a/b", payload, 2, 1, 0x1234, 0);
    CHECK(n == (int)sizeof want_qos1);
    CHECK(memcmp(out, want_qos1, sizeof want_qos1) == 0);

    n = mqtt_encode_publish(out, sizeof out, "a/b", payload, 2, 1, 0x1234, 1);
    CHECK(n > 0 && out[0] == 0x3A); /* DUP flag set on retransmit */

    n = mqtt_encode_publish(out, sizeof out, "a/b", payload, 2, 0, 0, 1);
    CHECK(n == 9 && out[0] == 0x30); /* QoS 0: no packet id, DUP ignored */

    CHECK(mqtt_encode_publish(out, sizeof out, "a/b", payload, 2, 1, 0, 0) == MQTT_ERR_ARG);
    CHECK(mqtt_encode_publish(out, sizeof out, "a/b", payload, 2, 2, 1, 0) == MQTT_ERR_ARG);
    CHECK(mqtt_encode_publish(out, sizeof out, "", payload, 2, 0, 0, 0) == MQTT_ERR_ARG);
}

TEST(decode_broker_packets)
{
    mqtt_packet p;
    const uint8_t connack_ok[] = {0x20, 0x02, 0x00, 0x00};
    const uint8_t connack_auth[] = {0x20, 0x02, 0x00, 0x05};
    const uint8_t puback[] = {0x40, 0x02, 0xAB, 0xCD};
    const uint8_t pingresp[] = {0xD0, 0x00};
    const uint8_t bad_puback[] = {0x40, 0x03, 0x00, 0x01, 0x00};
    const uint8_t two[] = {0x40, 0x02, 0x00, 0x01, 0x40, 0x02, 0x00, 0x02};

    CHECK(mqtt_decode(connack_ok, sizeof connack_ok, &p) == 0);
    CHECK(p.type == MQTT_CONNACK && p.connack_rc == 0 && p.length == 4);
    CHECK(mqtt_decode(connack_auth, sizeof connack_auth, &p) == 0 && p.connack_rc == MQTT_CONNACK_NOT_AUTHORIZED);
    CHECK(mqtt_decode(puback, sizeof puback, &p) == 0 && p.type == MQTT_PUBACK && p.packet_id == 0xABCD);
    CHECK(mqtt_decode(pingresp, sizeof pingresp, &p) == 0 && p.type == MQTT_PINGRESP);
    CHECK(mqtt_decode(puback, 3, &p) == MQTT_ERR_INCOMPLETE); /* split across TCP reads */
    CHECK(mqtt_decode(bad_puback, sizeof bad_puback, &p) == MQTT_ERR_MALFORMED);
    /* two packets back to back: decode consumes exactly the first */
    CHECK(mqtt_decode(two, sizeof two, &p) == 0 && p.packet_id == 1 && p.length == 4);
    CHECK(mqtt_decode(two + p.length, sizeof two - p.length, &p) == 0 && p.packet_id == 2);
}

TEST(outbox_ack_and_release_in_order)
{
    static outbox ob;
    outbox_msg *a, *b, *c;
    outbox_init(&ob);
    outbox_push(&ob, 1, (const uint8_t *)"a", 1);
    outbox_push(&ob, 2, (const uint8_t *)"b", 1);
    outbox_push(&ob, 3, (const uint8_t *)"c", 1);

    a = outbox_next(&ob, 0, 1000, 8); outbox_mark_sent(&ob, a, 0);
    b = outbox_next(&ob, 0, 1000, 8); outbox_mark_sent(&ob, b, 0);
    c = outbox_next(&ob, 0, 1000, 8); outbox_mark_sent(&ob, c, 0);
    CHECK(a->seq == 1 && b->seq == 2 && c->seq == 3);
    CHECK(a->packet_id == 1 && b->packet_id == 2 && c->packet_id == 3);
    CHECK(outbox_inflight(&ob) == 3);
    CHECK(outbox_next(&ob, 10, 1000, 8) == NULL);

    CHECK(outbox_ack(&ob, 2) == 1);   /* out of order: middle acked */
    CHECK(outbox_count(&ob) == 3);    /* head still pending, nothing released */
    CHECK(outbox_ack(&ob, 1) == 1);
    CHECK(outbox_count(&ob) == 1);    /* 1 and 2 released together */
    CHECK(outbox_ack(&ob, 99) == 0);  /* unknown id ignored */
    CHECK(outbox_ack(&ob, 3) == 1 && outbox_count(&ob) == 0);
}

TEST(outbox_retransmit_and_window)
{
    static outbox ob;
    outbox_msg *m;
    outbox_init(&ob);
    outbox_push(&ob, 1, (const uint8_t *)"a", 1);
    outbox_push(&ob, 2, (const uint8_t *)"b", 1);

    m = outbox_next(&ob, 0, 1000, 1);
    outbox_mark_sent(&ob, m, 0);
    CHECK(outbox_next(&ob, 500, 1000, 1) == NULL); /* window of 1 is full */

    m = outbox_next(&ob, 1000, 1000, 1);           /* ack timed out */
    CHECK(m != NULL && m->seq == 1 && m->dup == 1);
    outbox_mark_sent(&ob, m, 1000);
    CHECK(m->packet_id == 1);                      /* same id on retransmit */

    outbox_requeue_inflight(&ob);                  /* reconnect */
    m = outbox_next(&ob, 1001, 1000, 1);
    CHECK(m != NULL && m->seq == 1 && m->dup == 1 && m->state == OUTBOX_QUEUED);
}

TEST(outbox_overflow_evicts_oldest)
{
    static outbox ob;
    int i, evicted = 0;
    outbox_msg *m;
    outbox_init(&ob);
    for (i = 0; i < OUTBOX_CAPACITY + 5; i++) {
        evicted += outbox_push(&ob, i, (const uint8_t *)"x", 1);
    }
    CHECK(evicted == 5);
    CHECK(ob.dropped == 5);
    CHECK(outbox_count(&ob) == OUTBOX_CAPACITY);
    m = outbox_next(&ob, 0, 1000, 8);
    CHECK(m != NULL && m->seq == 5); /* oldest surviving message */
    {
        uint8_t big[OUTBOX_PAYLOAD_MAX + 1] = {0};
        CHECK(outbox_push(&ob, 999, big, sizeof big) == -1);
    }
}

TEST(packet_id_wraps_and_skips_zero)
{
    static outbox ob;
    outbox_msg *m;
    outbox_init(&ob);
    ob.next_packet_id = 65535;
    outbox_push(&ob, 1, (const uint8_t *)"a", 1);
    outbox_push(&ob, 2, (const uint8_t *)"b", 1);
    m = outbox_next(&ob, 0, 1000, 8); outbox_mark_sent(&ob, m, 0);
    CHECK(m->packet_id == 65535);
    m = outbox_next(&ob, 0, 1000, 8); outbox_mark_sent(&ob, m, 0);
    CHECK(m->packet_id == 1);
}

TEST(backoff_grows_caps_and_resets)
{
    backoff b;
    uint32_t d;
    int i;
    backoff_init(&b, 500, 30000);
    CHECK(backoff_ceiling(&b) == 500);
    d = backoff_next(&b, 0.999);
    CHECK(d <= 500 && d >= 250);
    CHECK(backoff_ceiling(&b) == 1000);
    for (i = 0; i < 100; i++) {
        d = backoff_next(&b, 0.999);
    }
    CHECK(backoff_ceiling(&b) == 30000); /* no overflow after many attempts */
    CHECK(d <= 30000);
    CHECK(backoff_next(&b, 0.0) == 250); /* floor prevents a zero-delay spin */
    backoff_reset(&b);
    CHECK(backoff_ceiling(&b) == 500);
}

TEST(sensor_model_is_deterministic_and_faults_work)
{
    sensor_model a, b;
    double before;
    int i;
    sensor_init(&a, KIND_PUMP, "pump-01");
    sensor_init(&b, KIND_PUMP, "pump-01");
    for (i = 0; i < 50; i++) {
        sensor_step(&a, 1.0);
        sensor_step(&b, 1.0);
    }
    CHECK(a.n == 3 && memcmp(a.metrics, b.metrics, sizeof a.metrics) == 0);
    CHECK(a.metrics[0].value > 35.0 && a.metrics[0].value < 60.0);

    before = a.metrics[0].value;
    sensor_set_fault(&a, FAULT_OVERHEAT);
    for (i = 0; i < 30; i++) {
        sensor_step(&a, 1.0);
    }
    CHECK(a.metrics[0].value > before + 30.0);

    sensor_set_fault(&a, FAULT_STUCK);
    before = a.metrics[1].value;
    sensor_step(&a, 1.0);
    CHECK(a.metrics[1].value == before);
}

TEST(payload_format)
{
    sensor_model m;
    char out[256];
    int n;
    memset(&m, 0, sizeof m);
    m.n = 2;
    m.metrics[0].name = "temperature_c";
    m.metrics[0].value = 21.5;
    m.metrics[1].name = "humidity_pct";
    m.metrics[1].value = 40.0;
    n = sensor_format_payload(&m, 4000000000u, 7, 1700000000000LL, out, sizeof out);
    CHECK(n > 0);
    CHECK(strcmp(out, "{\"boot\":4000000000,\"seq\":7,\"ts\":1700000000000,\"metrics\":{\"temperature_c\":21.500,\"humidity_pct\":40.000}}") == 0);
    CHECK(sensor_format_payload(&m, 1, 7, 1700000000000LL, out, 20) == -1);
}

int main(void)
{
    RUN(remaining_length_boundaries);
    RUN(connect_packet_bytes);
    RUN(publish_packet_bytes);
    RUN(decode_broker_packets);
    RUN(outbox_ack_and_release_in_order);
    RUN(outbox_retransmit_and_window);
    RUN(outbox_overflow_evicts_oldest);
    RUN(packet_id_wraps_and_skips_zero);
    RUN(backoff_grows_caps_and_resets);
    RUN(sensor_model_is_deterministic_and_faults_work);
    RUN(payload_format);
    printf("\n%d checks, %d failed\n", g_run, g_failed);
    return g_failed ? 1 : 0;
}
