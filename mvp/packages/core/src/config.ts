import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const EnvSchema = z
  .object({
    CHAT_PROVIDER: z.enum(["terminal", "photon"]).default("terminal"),
    GEMINI_API_KEY: optionalString,
    GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
    GOOGLE_MAPS_API_KEY: optionalString,
    DATABASE_URL: optionalString,
    PHOTON_PROJECT_ID: optionalString,
    PHOTON_PROJECT_SECRET: optionalString,
    AGENT_NAME: z.string().default("agent"),
    TIMEZONE: z.string().default("America/New_York"),
    MESSAGE_BATCH_DELAY_MS: z.coerce.number().int().min(0).default(2000),
    HEALTH_PORT: z.coerce.number().int().min(0).default(8080),
    GIT_SHA: z.string().default("dev"),
    LOG_LEVEL: z.string().default("info"),
  })
  .superRefine((env, ctx) => {
    // The live channel refuses to start half-configured. Terminal mode runs with whatever is set,
    // and the missing skills report themselves as unavailable.
    if (env.CHAT_PROVIDER !== "photon") return;
    for (const key of [
      "GEMINI_API_KEY",
      "GOOGLE_MAPS_API_KEY",
      "DATABASE_URL",
      "PHOTON_PROJECT_ID",
      "PHOTON_PROJECT_SECRET",
    ] as const) {
      if (!env[key])
        ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when CHAT_PROVIDER=photon` });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `- ${issue.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
