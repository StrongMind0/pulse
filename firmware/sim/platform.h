/*
 * Thin platform layer for the host simulator (Winsock or BSD sockets).
 * On the ESP32 build this is replaced by lwIP/esp_timer equivalents; the
 * core library never calls the OS directly.
 */
#ifndef PULSE_PLATFORM_H
#define PULSE_PLATFORM_H

#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32
#include <winsock2.h>
typedef SOCKET sock_t;
#define SOCK_INVALID INVALID_SOCKET
#else
typedef int sock_t;
#define SOCK_INVALID (-1)
#endif

int plat_init(void);
void plat_cleanup(void);

uint64_t plat_now_ms(void);  /* monotonic, for timers */
int64_t plat_wall_ms(void);  /* unix epoch millis, for timestamps */
void plat_sleep_ms(uint32_t ms);

/* Blocking connect, then switch the socket to non-blocking. */
sock_t plat_connect(const char *host, uint16_t port);

/* Returns 0 on success, -1 on error. */
int plat_send_all(sock_t s, const uint8_t *buf, size_t len);

/* Non-blocking read. Returns bytes read, 0 if nothing available, -1 if the
 * connection is closed or broken. */
int plat_recv(sock_t s, uint8_t *buf, size_t cap);

void plat_close(sock_t s);

#endif
