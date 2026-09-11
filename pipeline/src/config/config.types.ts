import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3020),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Hourly milestone due check on orchestrator (P9). */
  SCHEDULE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** IANA zone for milestone due_on (T−1 / T). */
  SCHEDULE_TZ: z.string().default("Europe/Moscow"),
  GITHUB_TOKEN: z.string().default(""),
  GITHUB_REPO: z.string().default(""),
  CURSOR_API_KEY: z.string().default(""),
  CURSOR_REPO_URL: z.string().default(""),
  CURSOR_STARTING_REF: z.string().default("main"),
  CURSOR_MODEL: z.string().default("composer-2.5"),
  DATA_DIR: z.string().default("/data"),
  PROMPTS_DIR: z.string().default("/app/prompts"),
  /** stub = echo only; compose = docker compose checkout продукта. */
  DEPLOY_MODE: z.enum(["stub", "compose"]).default("stub"),
  DEPLOY_COMPOSE_FILE: z.string().default("docker-compose.yml"),
  /** Путь к checkout продукта внутри контейнера deployer. */
  WORKSPACE_DIR: z.string().default("/product"),
});

export type EnvConfig = z.infer<typeof envSchema>;
export type OwnerRepo = { owner: string; repo: string } | null;
