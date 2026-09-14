import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Role } from '@types';

import { CursorIssue, CursorPull } from './CursorProvider.types';

export const loadPrompt = (promptsDir: string, role: Role): string =>
  readFileSync(join(promptsDir, `${role}.md`), 'utf8');

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
