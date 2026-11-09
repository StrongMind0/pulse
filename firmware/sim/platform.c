#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif

#include "platform.h"

#include <stdio.h>
#include <string.h>

#ifdef _WIN32
#include <ws2tcpip.h>
#include <windows.h>
#define last_err() WSAGetLastError()
#define WOULD_BLOCK(e) ((e) == WSAEWOULDBLOCK)
#else
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#define last_err() errno
#define WOULD_BLOCK(e) ((e) == EAGAIN || (e) == EWOULDBLOCK)
#endif

int plat_init(void)
{
#ifdef _WIN32
    WSADATA wsa;
    return WSAStartup(MAKEWORD(2, 2), &wsa) == 0 ? 0 : -1;
#else
    return 0;
#endif
}

void plat_cleanup(void)
{
#ifdef _WIN32
    WSACleanup();
#endif
}

uint64_t plat_now_ms(void)
{
#ifdef _WIN32
    return (uint64_t)GetTickCount64();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
#endif
}

int64_t plat_wall_ms(void)
{
#ifdef _WIN32
    FILETIME ft;
    ULARGE_INTEGER t;
    GetSystemTimeAsFileTime(&ft);
    t.LowPart = ft.dwLowDateTime;
    t.HighPart = ft.dwHighDateTime;
    /* 100ns ticks since 1601 -> ms since 1970 */
    return (int64_t)((t.QuadPart - 116444736000000000ULL) / 10000ULL);
#else
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
#endif
}

void plat_sleep_ms(uint32_t ms)
{
#ifdef _WIN32
    Sleep(ms);
#else
    struct timespec ts;
    ts.tv_sec = ms / 1000u;
    ts.tv_nsec = (long)(ms % 1000u) * 1000000L;
    nanosleep(&ts, NULL);
#endif
}

static int set_nonblocking(sock_t s)
{
#ifdef _WIN32
    u_long on = 1;
    return ioctlsocket(s, FIONBIO, &on) == 0 ? 0 : -1;
#else
    int flags = fcntl(s, F_GETFL, 0);
    return (flags >= 0 && fcntl(s, F_SETFL, flags | O_NONBLOCK) == 0) ? 0 : -1;
#endif
}

sock_t plat_connect(const char *host, uint16_t port)
{
    struct addrinfo hints, *res = NULL, *ai;
    char portstr[8];
    sock_t s = SOCK_INVALID;
    int one = 1;

    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    snprintf(portstr, sizeof portstr, "%u", (unsigned)port);
    if (getaddrinfo(host, portstr, &hints, &res) != 0) {
        return SOCK_INVALID;
    }
    for (ai = res; ai; ai = ai->ai_next) {
        s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s == SOCK_INVALID) {
            continue;
        }
        if (connect(s, ai->ai_addr, (int)ai->ai_addrlen) == 0) {
            break;
        }
        plat_close(s);
        s = SOCK_INVALID;
    }
    freeaddrinfo(res);
    if (s == SOCK_INVALID) {
        return SOCK_INVALID;
    }
    /* Telemetry packets are tiny; don't let Nagle hold them back. */
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one);
    if (set_nonblocking(s) != 0) {
        plat_close(s);
        return SOCK_INVALID;
    }
    return s;
}

int plat_send_all(sock_t s, const uint8_t *buf, size_t len)
{
    size_t sent = 0;
    int spins = 0;
    while (sent < len) {
#ifdef _WIN32
        int n = send(s, (const char *)buf + sent, (int)(len - sent), 0);
#else
        ssize_t n = send(s, buf + sent, len - sent, MSG_NOSIGNAL);
#endif
        if (n > 0) {
            sent += (size_t)n;
            continue;
        }
        if (n < 0 && WOULD_BLOCK(last_err()) && spins++ < 200) {
            plat_sleep_ms(5); /* kernel buffer full; brief wait, then give up */
            continue;
        }
        return -1;
    }
    return 0;
}

int plat_recv(sock_t s, uint8_t *buf, size_t cap)
{
#ifdef _WIN32
    int n = recv(s, (char *)buf, (int)cap, 0);
#else
    ssize_t n = recv(s, buf, cap, 0);
#endif
    if (n > 0) {
        return (int)n;
    }
    if (n == 0) {
        return -1; /* orderly shutdown by peer */
    }
    return WOULD_BLOCK(last_err()) ? 0 : -1;
}

void plat_close(sock_t s)
{
    if (s == SOCK_INVALID) {
        return;
    }
#ifdef _WIN32
    closesocket(s);
#else
    close(s);
#endif
}
