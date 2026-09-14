import {
  GITHUB_COMMENT_MAX,
  GITHUB_PIPELINE_LABELS,
} from './GithubProvider.constants';
import {
  GitHubIssue,
  GitHubIssueRaw,
  GitHubLabelRaw,
  PipelineLabel,
} from './GithubProvider.types';

export const generateJobComment = (params: {
  jobId: string;
  role: string;
  agentId: string | null;
  runId: string | null;
  status: string;
  error?: string | null;
  decision?: string | null;
}): string => {
  const lines = [
    `<!-- pipeline:job:${params.jobId} -->`,
    `Пайплайн: роль \`${params.role}\`, статус \`${params.status}\`.`,
    params.agentId ? `agentId: \`${params.agentId}\`` : 'agentId: —',
    params.runId ? `runId: \`${params.runId}\`` : 'runId: —',
  ];

  if (params.decision) {
    lines.push(`Решение: \`${params.decision}\`.`);
  }

  if (params.error) {
    lines.push(`Ошибка: ${params.error}`);
  }

  return lines.join('\n');
};

export const generateAgentResultComment = (
  role: string,
  text: string,
): string => {
  const header = `## Результат: ${role}\n\n`;
  const trimmed = text.trim() || '(пустой ответ агента)';

  if (header.length + trimmed.length <= GITHUB_COMMENT_MAX) {
    return header + trimmed;
  }

  const budget = GITHUB_COMMENT_MAX - header.length - 40;

  return (
    `${header}${trimmed.slice(0, budget)}` +
    '\n\n… (обрезано, полный текст в Cursor SDK)'
  );
};

export const getLabelNames = (labels: GitHubLabelRaw[]): string[] => {
  return labels.map((label) =>
    typeof label === 'string' ? label : label.name,
  );
};

export const convertRawIssuetoGitHubIssue = (
  item: GitHubIssueRaw,
): GitHubIssue => {
  return {
    number: item.number,
    title: item.title,
    body: item.body,
    html_url: item.html_url,
    labels: getLabelNames(item.labels),
    milestone: item.milestone ?? null,
  };
};

export const getPreviousReleaseTag = (
  releases: Array<{ tag_name: string; published_at: string | null }>,
  currentTag: string,
): string | null => {
  const others = releases
    .filter((item) => item.tag_name !== currentTag)
    .sort((a, b) => {
      const aTime = a.published_at ? Date.parse(a.published_at) : 0;
      const bTime = b.published_at ? Date.parse(b.published_at) : 0;

      return bTime - aTime;
    });

  return others[0]?.tag_name ?? null;
};

/**
 * No previous published tag → first release, not empty.
 * Unknown aheadBy → do not skip.
 */
export const isEmptySincePreviousRelease = (params: {
  previousTag: string | null;
  aheadBy: number | null;
}): boolean => {
  if (!params.previousTag) {
    return false;
  }

  if (params.aheadBy === null) {
    return false;
  }

  return params.aheadBy <= 0;
};

export const fixIssueWithPR = (
  pr: {
    title: string;
    body: string | null;
    headRef: string;
  },
  issue: number,
): boolean => {
  const text = `${pr.title}\n${pr.body ?? ''}`;
  const keywords = new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue}\\b`,
    'i',
  );

  if (keywords.test(text)) {
    return true;
  }

  return new RegExp(`^issue/${issue}(?:-|$)`).test(pr.headRef);
};

export const getMissingPipelineLabels = (
  existingNames: string[],
): PipelineLabel[] => {
  const have = new Set(existingNames.map((name) => name.toLowerCase()));

  return GITHUB_PIPELINE_LABELS.filter(
    (label) => !have.has(label.name.toLowerCase()),
  );
};

export const isTransientNetworkError = (err: unknown): boolean => {
  const parts: string[] = [];
  let current: unknown = err;

  for (let i = 0; i < 4 && current; i++) {
    if (current instanceof Error) {
      parts.push(current.message, current.name);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|fetch failed/i.test(
    parts.join(' '),
  );
};

export const githubFetch = async (
  url: string | URL,
  init?: RequestInit,
): Promise<Response> => {
  const attempts = 3;
  let last: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      last = err;

      if (!isTransientNetworkError(err) || i === attempts - 1) {
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }

  throw last;
};
