import { Config } from '@config';
import { GitHubClient } from '@providers';

function printUsage(): void {
  console.error('usage: npm run ensure-labels -- [owner/repo]');
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
