import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config";

const execFileAsync = promisify(execFile);

export type DeployRunResult = {
  ok: boolean;
  detail: string;
};

export async function runProductDeploy(config: Config, tag: string): Promise<DeployRunResult> {
  if (config.DEPLOY_MODE === "stub") {
    return {
      ok: true,
      detail: `stub: tag \`${tag}\` доехал, docker compose продукта не запускался (DEPLOY_MODE=stub).`,
    };
  }

  const composeFile = config.DEPLOY_COMPOSE_FILE;
  const cwd = config.WORKSPACE_DIR;

  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["compose", "-f", composeFile, "up", "-d"],
      {
        cwd,
        env: process.env,
        timeout: 120_000,
        maxBuffer: 2_000_000,
      },
    );
    const out = `${stdout}\n${stderr}`.trim();

    return {
      ok: true,
      detail: `compose up -d (\`${composeFile}\`, tag \`${tag}\`):\n\`\`\`\n${out.slice(0, 3500)}\n\`\`\``,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const execErr = err as { stdout?: unknown; stderr?: unknown };
    const stdout = String(execErr?.stdout ?? "");
    const stderr = String(execErr?.stderr ?? "");

    return {
      ok: false,
      detail: `compose failed (tag \`${tag}\`): ${message}\n\`\`\`\n${`${stdout}\n${stderr}`.trim().slice(0, 3500)}\n\`\`\``,
    };
  }
}
