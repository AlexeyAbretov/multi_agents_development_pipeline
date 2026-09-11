import { EnvConfig, envSchema, type OwnerRepo } from "./config.types";

export interface Config extends EnvConfig {}

export class Config {
  private constructor(env: NodeJS.ProcessEnv) {
    const parsed = envSchema.parse(env);

    Object.assign(this, {
      ...parsed,
      CURSOR_REPO_URL:
        parsed.CURSOR_REPO_URL ||
        (parsed.GITHUB_REPO ? `https://github.com/${parsed.GITHUB_REPO}` : ""),
    });
  }

  static loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    return new Config(env);
  }

  get ownerRepo(): OwnerRepo {
    const [owner, name] = this.GITHUB_REPO.split("/");

    if (!owner || !name || this.GITHUB_REPO.split("/").length !== 2) {
      return null;
    }

    return { owner, repo: name };
  }
}
