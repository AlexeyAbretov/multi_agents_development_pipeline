import { z } from "zod";

const envSchema = z.object({
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

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const repoUrl =
    parsed.CURSOR_REPO_URL ||
    (parsed.GITHUB_REPO ? `https://github.com/${parsed.GITHUB_REPO}` : "");
  return { ...parsed, CURSOR_REPO_URL: repoUrl };
}

export function parseOwnerRepo(repo: string): { owner: string; repo: string } | null {
  const [owner, name] = repo.split("/");
  if (!owner || !name || repo.split("/").length !== 2) {
    return null;
  }
  return { owner, repo: name };
}
