"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ApiError, WS_URL, api } from "./api";
import { initialState, reducer, HISTORY_POINTS } from "./store";
import type { Alert, LiveEvent, Reading, Session } from "./types";

export type Connection = "connecting" | "live" | "reconnecting";

/**
 * Keeps the dashboard in sync with the fleet:
 *   1. load a REST snapshot (devices, alerts, recent history)
 *   2. stream live events over a WebSocket
 *   3. on any disconnect: back off, reconnect, and take a fresh snapshot,
 *      because events sent while we were away are gone
 */
export function useLive(session: Session, onUnauthorized: () => void) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [rate, setRate] = useState(0);
  const client = useMemo(() => api(session.token), [session.token]);

  const onUnauthorizedRef = useRef(onUnauthorized);
  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  const snapshot = useCallback(async () => {
    const [{ devices }, { alerts }] = await Promise.all([client.devices(), client.alerts()]);
    const history: Record<string, Reading[]> = {};
    // bounded concurrency: a 500-device fleet must not fire 500 requests at once
    const queue = [...devices];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let d = queue.shift(); d; d = queue.shift()) {
          history[d.id] = (await client.readings(d.id, HISTORY_POINTS)).readings;
        }
      }),
    );
    dispatch({ type: "snapshot", devices, alerts, history });
  }, [client]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let pending: LiveEvent[] = [];
    let held: LiveEvent[] | null = null; // events that arrive while a snapshot is loading
    let readingsThisSecond = 0;

    const flush = () => {
      frame = 0;
      const events = pending;
      pending = [];
      if (events.length) dispatch({ type: "batch", events });
    };

    const fail = (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onUnauthorizedRef.current();
    };

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(WS_URL);
      ws.onopen = () => ws?.send(JSON.stringify({ type: "auth", token: session.token }));
      ws.onmessage = (m) => {
        let ev: LiveEvent | { type: "ready" };
        try {
          ev = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (ev.type === "ready") {
          attempt = 0;
          setConnection("live");
          held = [];
          snapshot()
            .then(() => {
              // replay what streamed in meanwhile; the reducer drops anything
              // the snapshot already contained
              if (held?.length) dispatch({ type: "batch", events: held });
            })
            .catch(fail)
            .finally(() => {
              held = null;
            });
          return;
        }
        if (ev.type === "reading") readingsThisSecond++;
        if (held) {
          held.push(ev);
          return;
        }
        pending.push(ev);
        if (!frame) frame = requestAnimationFrame(flush);
      };
      ws.onclose = (e) => {
        ws = null;
        if (stopped) return;
        if (e.code === 4401) {
          onUnauthorizedRef.current();
          return;
        }
        setConnection("reconnecting");
        const delay = Math.min(15_000, 500 * 2 ** attempt++) * (0.5 + Math.random() / 2);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    const rateTimer = setInterval(() => {
      setRate(readingsThisSecond);
      readingsThisSecond = 0;
    }, 1000);

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(rateTimer);
      if (frame) cancelAnimationFrame(frame);
      ws?.close(1000, "unmount");
    };
  }, [session.token, snapshot]);

  const acknowledge = useCallback(
    async (id: string): Promise<void> => {
      try {
        const updated: Alert = await client.acknowledge(id);
        dispatch({ type: "alert", alert: updated });
      } catch (err) {
        fail(err);
        throw err;
      }
      function fail(err: unknown) {
        if (err instanceof ApiError && err.status === 401) onUnauthorizedRef.current();
      }
    },
    [client],
  );

  return { state, connection, rate, acknowledge, client };
}

/** A clock that ticks in an effect, never during render (prerender-safe). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}
