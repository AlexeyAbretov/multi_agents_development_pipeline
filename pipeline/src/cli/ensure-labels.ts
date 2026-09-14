import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { Config } from '@config';
import { GitHubClient } from '@providers';

function printUsage(): void {
  console.error('usage: npm run ensure-labels -- [owner/repo]');
}

function envSearchDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const pipelineDir = resolve(here, '../..');

  return [...new Set([process.cwd(), pipelineDir])];
}

function loadEnvFile(): void {
  const files = ['.env.local', '.env'];

  for (const dir of envSearchDirs()) {
    for (const file of files) {
      const path = resolve(dir, file);

      if (!existsSync(path)) {
        continue;
      }

      const parsed = parseEnv(readFileSync(path, 'utf8'));

      for (const [key, value] of Object.entries(parsed)) {
        if (value === undefined) {
          continue;
        }

        process.env[key] ??= value;
      }

      return;
    }
  }
}

function repoFromArg(value: string | undefined): string | undefined {
  if (!value || value.startsWith('-')) {
    return undefined;
  }

  const trimmed = value.trim().replace(/\.git$/i, '');
  const fromUrl = trimmed.match(/github\.com[:/]([^/]+\/[^/]+)/i);

  if (fromUrl?.[1]) {
    return fromUrl[1];
  }

  return trimmed;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  loadEnvFile();

  const repo = repoFromArg(process.argv[2]);

  if (repo) {
    process.env.GITHUB_REPO = repo;
  }

  const config = Config.loadConfig();

  if (!config.GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN is required');
    process.exit(1);
  }

  if (!config.ownerRepo) {
    printUsage();
    process.exit(1);
  }

  const { owner, repo: name } = config.ownerRepo;
  const github = new GitHubClient(config);
  const result = await github.ensurePipelineLabels();

  console.log(`repo: ${owner}/${name}`);

  if (result.created.length > 0) {
    console.log(`created: ${result.created.join(', ')}`);
  }

  if (result.skipped.length > 0) {
    console.log(`exists: ${result.skipped.join(', ')}`);
  }

  console.log('done');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
