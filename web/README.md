# Pulse dashboard

Next.js 16 and React 19 client for the Pulse gateway. See the [root README](../README.md).

```bash
npm run dev        # http://localhost:3000 (expects the gateway on :8080)
npm test           # reducer tests
npm run lint && npm run typecheck
```

`NEXT_PUBLIC_GATEWAY_URL` sets the gateway address. It is inlined at **build** time.

- `src/lib/useLive.ts`: snapshot plus WebSocket sync, reconnect with backoff, one render per
  animation frame
- `src/lib/store.ts`: pure reducer that merges REST snapshots and live events
- `src/components/LineChart.tsx`: single-series chart with hover and keyboard crosshair, plus an
  alert-limit reference line
