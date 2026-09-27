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
    /** The website API and /healthz. */
    HTTP_PORT: z.coerce.number().int().min(0).default(8080),
    // Website accounts (moved from DeepSpace). Without SITE_AUTH_SECRET the account routes answer site_unconfigured.
    SITE_AUTH_SECRET: optionalString,
    BETA_MAX_USERS: z.coerce.number().int().min(1).default(100),
    RESEND_API_KEY: optionalString,
    EMAIL_FROM: z.string().default("plansaroundus <noreply@plansaroundus.tech>"),
    /** Fallback @agent number when Photon can't assign one per person. */
    AGENT_NUMBER: optionalString,
    PHOTON_LINE_TYPE: z.enum(["shared", "dedicated"]).default("shared"),
    /** Comma-separated origins allowed to call /api from a browser, e.g. https://plansaroundus.tech. */
    WEB_ALLOWED_ORIGINS: z
      .string()
      .default("*")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim().replace(/\/$/, ""))
          .filter(Boolean),
      ),
    /** Terminal mode only: act as this phone so website sign-in can be tested without Photon. */
    TERMINAL_PHONE: optionalString,
    GIT_SHA: z.string().default("dev"),
    LOG_LEVEL: z.string().default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.SITE_AUTH_SECRET && env.SITE_AUTH_SECRET.length < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["SITE_AUTH_SECRET"],
        message: "SITE_AUTH_SECRET must be at least 32 characters",
      });
    }
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
