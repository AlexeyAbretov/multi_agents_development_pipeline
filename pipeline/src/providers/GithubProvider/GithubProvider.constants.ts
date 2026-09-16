import type { PipelineLabel } from './GithubProvider.types';

export const GITHUB_COMMENT_MAX = 60_000;

/** Labels from docs/AGENT_PIPELINE.md §3. Names must match GitHub exactly. */
export const GITHUB_PIPELINE_LABELS: PipelineLabel[] = [
  {
    name: 'bug',
    color: 'd73a4a',
    description: 'Тип: дефект',
  },
  {
    name: 'feature',
    color: '1d76db',
    description: 'Тип: фича',
  },
  {
    name: 'regression',
    color: 'e99695',
    description: 'Служебная issue регресса main',
  },
  {
    name: 'mvp',
    color: '6f42c1',
    description: 'Тип: стартовая задача проекта',
  },
  {
    name: 'p0',
    color: 'b60205',
    description: 'Приоритет: критический',
  },
  {
    name: 'p1',
    color: 'd93f0b',
    description: 'Приоритет: высокий',
  },
  {
    name: 'p2',
    color: 'fbca04',
    description: 'Приоритет: средний',
  },
  {
    name: 'p3',
    color: '0e8a16',
    description: 'Приоритет: низкий',
  },
  {
    name: 'needs-plan',
    color: 'c5def5',
    description: 'Очередь аналитика',
  },
  {
    name: 'in-analysis',
    color: '0052cc',
    description: 'Аналитик работает',
  },
  {
    name: 'ready-for-dev',
    color: '5319e7',
    description: 'План есть, очередь разработчика',
  },
  {
    name: 'in-dev',
    color: '1d76db',
    description: 'Разработчик работает',
  },
  {
    name: 'in-qa',
    color: 'fbca04',
    description: 'PR ждёт QA или исправления',
  },
  {
    name: 'qa-in-progress',
    color: 'f9d0c4',
    description: 'Тестировщик работает',
  },
  {
    name: 'qa-passed',
    color: '0e8a16',
    description: 'QA успешно пройден',
  },
  {
    name: 'deployed',
    color: '0e8a16',
    description: 'Локальный деплой успешен',
  },
  {
    name: 'deploy-failed',
    color: 'd73a4a',
    description: 'Локальный деплой упал',
  },
  {
    name: 'needs-human',
    color: 'e11d21',
    description: 'Стоп автоматики',
  },
  {
    name: 'to-approve',
    color: 'd4c5f9',
    description: 'План MVP ждёт подтверждения человека',
  },
  {
    name: 'approved',
    color: 'c2e0c6',
    description: 'План MVP подтверждён, очередь создания задач',
  },
];
