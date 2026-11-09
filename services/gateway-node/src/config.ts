import { z } from "zod";

/** Every setting comes from the environment and is validated at startup. */
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("0.0.0.0"),
  INGEST_URL: z.url().default("http://127.0.0.1:8081"),
  RULES_URL: z.url().default("http://127.0.0.1:8082"),
  MQTT_URL: z.string().default("mqtt://127.0.0.1:1883"),
  PULSE_SERVICE_TOKEN: z.string().min(1, "PULSE_SERVICE_TOKEN is required"),
  PULSE_JWT_SECRET: z.string().min(32, "PULSE_JWT_SECRET must be at least 32 characters"),
  PULSE_ADMIN_USER: z.string().regex(/^[a-z][a-z0-9._-]{1,31}$/).default("admin"),
  PULSE_ADMIN_PASSWORD: z.string().min(8, "PULSE_ADMIN_PASSWORD must be at least 8 characters"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
