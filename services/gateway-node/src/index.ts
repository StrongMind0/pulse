import { Authenticator, LoginRateLimiter } from "./auth.js";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { connectBroker } from "./mqtt.js";
import { buildServer } from "./server.js";
import { httpUpstream } from "./upstream.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const auth = await Authenticator.create({ [cfg.PULSE_ADMIN_USER]: cfg.PULSE_ADMIN_PASSWORD }, cfg.PULSE_JWT_SECRET);
  const hub = new Hub();
  let broker: ReturnType<typeof connectBroker> | undefined;

  const app = await buildServer({
    auth,
    limiter: new LoginRateLimiter(),
    hub,
    upstream: httpUpstream({ ingest: cfg.INGEST_URL, rules: cfg.RULES_URL }),
    corsOrigin: cfg.CORS_ORIGIN,
    brokerConnected: () => broker?.connected ?? false,
    logLevel: cfg.LOG_LEVEL,
  });
  broker = connectBroker(cfg.MQTT_URL, cfg.PULSE_SERVICE_TOKEN, hub, app.log);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    broker?.end(true);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
