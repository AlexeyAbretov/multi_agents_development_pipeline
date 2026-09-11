export type GitHubRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
};

/** Published (not draft) releases are eligible — including pre-release. */
export function isDeployableRelease(release: Pick<GitHubRelease, "draft">): boolean {
  return !release.draft;
}

export function releasesToDeploy(
  releases: GitHubRelease[],
  alreadyDeployedIds: Set<number>,
): GitHubRelease[] {
  return releases
    .filter((release) => isDeployableRelease(release))
    .filter((release) => !alreadyDeployedIds.has(release.id))
    .sort((a, b) => {
      const aTime = a.published_at ? Date.parse(a.published_at) : 0;
      const bTime = b.published_at ? Date.parse(b.published_at) : 0;

      return aTime - bTime;
    });
}

export function deployMarker(releaseId: number): string {
  return `<!-- pipeline:deploy:${releaseId} -->`;
}

export function releaseBodyHasDeployMarker(body: string | null, releaseId: number): boolean {
  if (!body) {
    return false;
  }

  return body.includes(deployMarker(releaseId));
}

export function appendDeployNote(
  body: string | null,
  releaseId: number,
  status: "deployed" | "deploy-failed",
  detail: string,
): string {
  const marker = deployMarker(releaseId);
  const base = (body ?? "").replace(/\n*---\n<!-- pipeline:deploy:\d+ -->[\s\S]*$/m, "").trimEnd();
  const block = [
    "",
    "---",
    marker,
    `Локальный деплой: \`${status}\`.`,
    detail.trim(),
  ].join("\n");

  if (releaseBodyHasDeployMarker(body, releaseId)) {
    return `${base}${block}`;
  }

  return `${base}${block}`;
}
