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
    '',
    issue.body?.trim() || '(пустое описание)',
  ];

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
