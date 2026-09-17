import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Role } from '@types';

import type {
  CursorIssue,
  CursorModelSelection,
  CursorPull,
  CursorTokenUsage,
} from './CursorProvider.types';

const AGENT_RESULT_HEADER = /^## Результат: /;
const ANALYST_RESULT_HEADER = /^## Результат: analyst\b/;
const DEVELOPER_RESULT_HEADER = /^## Результат: developer\b/;

export const loadPrompt = (promptsDir: string, role: Role): string =>
  readFileSync(join(promptsDir, `${role}.md`), 'utf8');

export function shouldAttachIssueComments(role: Role): boolean {
  return role === 'analyst' || role === 'developer' || role === 'tester';
}

export function commentsForAgentRole<T extends { body: string }>(
  role: Role,
  comments: T[],
): T[] {
  if (role !== 'developer' && role !== 'tester') {
    return comments;
  }

  const lastPlan = [...comments]
    .reverse()
    .find((comment) => ANALYST_RESULT_HEADER.test(comment.body.trim()));

  const lastDevReport =
    role === 'tester'
      ? [...comments]
          .reverse()
          .find((comment) => DEVELOPER_RESULT_HEADER.test(comment.body.trim()))
      : undefined;

  const keep = new Set(
    comments.filter(
      (comment) => !AGENT_RESULT_HEADER.test(comment.body.trim()),
    ),
  );

  if (lastPlan) {
    keep.add(lastPlan);
  }

  if (lastDevReport) {
    keep.add(lastDevReport);
  }

  return comments.filter((comment) => keep.has(comment));
}

export function cursorModelSelection(modelId: string): CursorModelSelection {
  if (/fast/i.test(modelId)) {
    return { id: modelId };
  }

  if (!/^(composer|grok)/i.test(modelId)) {
    return { id: modelId };
  }

  return {
    id: modelId,
    params: [{ id: 'fast', value: 'false' }],
  };
}

export const buildMessage = (
  rolePrompt: string,
  issue: CursorIssue,
  pull?: CursorPull,
  role?: Role,
): string => {
  const lines = [
    rolePrompt.trim(),
    '',
    '## Issue',
    `Номер: #${issue.number}`,
    `URL: ${issue.html_url}`,
    `Заголовок: ${issue.title}`,
  ];

  if (issue.labels?.length) {
    lines.push(`Labels: ${issue.labels.join(', ')}`);
  }

  const labels = issue.labels ?? [];

  if (role === 'analyst' && labels.includes('mvp')) {
    const phase = labels.includes('needs-plan')
      ? 'план: вопросы → needs-human, готовый план → to-approve. ' +
        'GitHub issues не создавать.'
      : labels.includes('approved')
        ? 'создание задач: по утверждённому плану создать feature/bug ' +
          'issues. PIPELINE_MVP_TASKS — порядок разработки ' +
          '(запятая = этап, плюс = параллель), затем ' +
          'PIPELINE_LABELS: done.'
        : 'mvp';

    lines.push('', '## Фаза MVP', phase);
  }

  lines.push('', issue.body?.trim() || '(пустое описание)');

  if (issue.comments?.length) {
    lines.push('', '## Комментарии issue');

    for (const comment of issue.comments) {
      lines.push(
        '',
        `### ${comment.user} (${comment.createdAt})`,
        comment.body.trim() || '(пусто)',
      );
    }
  }

  if (issue.milestone) {
    lines.push(
      '',
      '## Milestone',
      `Title (tag): ${issue.milestone.title}`,
      `Due: ${issue.milestone.due_on ?? '(нет due)'}`,
    );
  }

  if (pull) {
    lines.push(
      '',
      '## Pull request',
      `Номер: #${pull.number}`,
      `URL: ${pull.html_url}`,
      `Ветка: ${pull.headRef}`,
      `Заголовок: ${pull.title}`,
    );

    if (role === 'developer') {
      lines.push(
        '',
        `База твоего PR: \`${pull.headRef}\` — **не** \`main\`.`,
        'Открой PR командой `gh pr create --base ' +
          pull.headRef +
          '` (Cursor autoCreatePR часто целится в default ' +
          'branch — сразу смени base, если открылся в main).',
      );
    }
  }

  return lines.join('\n');
};

export function formatCursorModel(
  selection: CursorModelSelection | undefined,
  fallbackId: string,
): string {
  const id = selection?.id || fallbackId;
  const params = selection?.params ?? [];

  if (params.length === 0) {
    return id;
  }

  const extra = params.map((param) => `${param.id}=${param.value}`).join(', ');

  return `${id} ${extra}`;
}

export function loggedCursorModel(
  live: CursorModelSelection | undefined,
  requested: CursorModelSelection,
): string {
  const id = live?.id || requested.id;
  const params = live?.params ?? requested.params;

  return formatCursorModel({ id, params }, requested.id);
}

function hasRecordedUsage(usage: CursorTokenUsage): boolean {
  return Boolean(
    usage.totalTokens ||
    usage.inputTokens ||
    usage.outputTokens ||
    usage.cacheReadTokens ||
    usage.cacheWriteTokens,
  );
}

function toCursorTokenUsage(usage: CursorTokenUsage): CursorTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
  };
}

export async function readCursorUsage(params: {
  fetchBilled: () => Promise<{ usage?: CursorTokenUsage }>;
  live?: CursorTokenUsage;
}): Promise<CursorTokenUsage | null> {
  try {
    const billed = (await params.fetchBilled()).usage;

    if (billed) {
      if (hasRecordedUsage(billed)) {
        return toCursorTokenUsage(billed);
      }
    }
  } catch {
    // billed usage can lag or 404; live counts still useful
  }

  const live = params.live;

  if (!live || !hasRecordedUsage(live)) {
    return null;
  }

  return toCursorTokenUsage(live);
}
