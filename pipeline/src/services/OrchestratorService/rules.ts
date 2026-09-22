import { GitHubIssueState } from '@providers';
import type { Role } from '@types';

import type { Job, JobStatus, UiJobStatus } from './OrchestratorService.types';
import { isRegressionIssue } from './schedule-rules';

export type AnalystDecision =
  'ready-for-dev' | 'needs-human' | 'to-approve' | 'done';
export type AnalystKind = 'work' | 'mvp-plan' | 'mvp-spawn';
export type DeveloperDecision = 'in-qa' | 'needs-human';
export type TesterDecision = 'in-qa' | 'qa-passed' | 'needs-human';
export type ReleaseManagerDecision = 'released' | 'needs-human';

export function isMvpIssue(labels: string[]): boolean {
  return labels.includes('mvp');
}

export function hasWorkType(labels: string[]): boolean {
  return labels.includes('bug') || labels.includes('feature');
}

export function analystKind(labels: string[]): AnalystKind | null {
  if (isMvpIssue(labels)) {
    if (labels.includes('needs-plan')) {
      return 'mvp-plan';
    }

    if (labels.includes('approved')) {
      return 'mvp-spawn';
    }

    return null;
  }

  if (hasWorkType(labels)) {
    return 'work';
  }

  return null;
}

export function isQaRole(role: Role): boolean {
  return role === 'tester' || role === 'tester-regression';
}

export function roleForLabels(
  labels: string[],
  body: string | null = null,
): Role | null {
  if (labels.includes('needs-human') || labels.includes('in-analysis')) {
    return null;
  }

  const regression = isRegressionIssue(labels, body);
  const workType = hasWorkType(labels);
  const mvp = isMvpIssue(labels);

  if (!workType && !regression && !mvp) {
    return null;
  }

  if (mvp) {
    if (labels.includes('needs-plan') || labels.includes('approved')) {
      return 'analyst';
    }

    return null;
  }

  if (
    workType &&
    labels.includes('needs-plan') &&
    !labels.includes('ready-for-dev')
  ) {
    return 'analyst';
  }

  if (
    workType &&
    labels.includes('ready-for-dev') &&
    !labels.includes('needs-plan') &&
    !labels.includes('in-dev') &&
    !labels.includes('in-qa')
  ) {
    return 'developer';
  }

  if (
    labels.includes('in-qa') &&
    !labels.includes('qa-in-progress') &&
    !labels.includes('qa-passed')
  ) {
    if (regression) {
      return 'tester-regression';
    }

    if (workType) {
      return 'tester';
    }
  }

  if (regression && labels.includes('qa-passed')) {
    return 'release-manager';
  }

  return null;
}

export function decideAnalystOutcome(
  runStatus: 'finished' | 'error' | 'startup_error',
  resultText: string | null,
  kind: AnalystKind = 'work',
): AnalystDecision {
  if (runStatus !== 'finished') {
    return 'needs-human';
  }

  if (kind === 'mvp-plan') {
    const marker = resultText?.match(
      /PIPELINE_LABELS:\s*(needs-human|to-approve)/i,
    );

    if (marker) {
      return marker[1].toLowerCase() as AnalystDecision;
    }

    if (resultText && /needs-human/i.test(resultText)) {
      return 'needs-human';
    }

    return 'to-approve';
  }

  if (kind === 'mvp-spawn') {
    const marker = resultText?.match(
      /^PIPELINE_LABELS:\s*(needs-human|done)\s*$/im,
    );
    const tasks = extractMvpTaskIssues(resultText);

    if (!marker || tasks === null) {
      return 'needs-human';
    }

    const requested = marker[1].toLowerCase();

    if (requested === 'needs-human') {
      return 'needs-human';
    }

    if (requested === 'done' && tasks.length > 0) {
      return 'done';
    }

    return 'needs-human';
  }

  const marker = resultText?.match(
    /PIPELINE_LABELS:\s*(needs-human|ready-for-dev)/i,
  );

  if (marker) {
    return marker[1].toLowerCase() as AnalystDecision;
  }

  if (resultText && /needs-human/i.test(resultText)) {
    return 'needs-human';
  }

  return 'ready-for-dev';
}

export function decideDeveloperOutcome(
  runStatus: 'finished' | 'error' | 'startup_error',
  hasOpenFixPr: boolean,
): DeveloperDecision {
  if (hasOpenFixPr) {
    return 'in-qa';
  }

  if (runStatus !== 'finished') {
    return 'needs-human';
  }

  return 'needs-human';
}

export function decideTesterOutcome(
  runStatus: 'finished' | 'error' | 'startup_error',
  resultText: string | null,
  bugIssues: number[] | null,
): TesterDecision {
  if (runStatus !== 'finished') {
    return 'needs-human';
  }

  const marker = resultText?.match(
    /^PIPELINE_LABELS:\s*(needs-human|in-qa|qa-passed)\s*$/im,
  );

  if (!marker || bugIssues === null) {
    return 'needs-human';
  }

  const requested = marker[1].toLowerCase() as TesterDecision;

  if (requested === 'needs-human') {
    return 'needs-human';
  }

  if (bugIssues.length === 0 && requested === 'qa-passed') {
    return 'qa-passed';
  }

  if (bugIssues.length > 0 && requested === 'in-qa') {
    return 'in-qa';
  }

  return 'needs-human';
}

/** Максимум дочерних bug-issues за один прогон тестировщика (корень). */
export const MAX_TESTER_CHILD_BUGS = 2;

export type TesterBugHandoff = 'ok' | 'too-many' | 'grandchild';

/** Глубина дерева QA = 1: дети не плодят внуков; на корне не больше MAX
 * багов. */
export function classifyTesterBugHandoff(
  parentBody: string | null,
  bugIssues: number[],
): TesterBugHandoff {
  if (bugIssues.length === 0) {
    return 'ok';
  }

  if (parseRelatedParentIssue(parentBody) !== null) {
    return 'grandchild';
  }

  if (bugIssues.length > MAX_TESTER_CHILD_BUGS) {
    return 'too-many';
  }

  return 'ok';
}

function extractIssueListMarker(
  resultText: string | null,
  markerName: string,
): number[] | null {
  const marker = resultText?.match(
    new RegExp(
      `^${markerName}:\\s*(none|(?:#?\\d+(?:\\s*,\\s*#?\\d+)*))\\s*$`,
      'im',
    ),
  );

  if (!marker) {
    return null;
  }

  if (marker[1].toLowerCase() === 'none') {
    return [];
  }

  return [
    ...new Set(
      marker[1]
        .split(',')
        .map((value) => Number(value.trim().replace(/^#/, '')))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}

export function extractTesterBugIssues(
  resultText: string | null,
): number[] | null {
  return extractIssueListMarker(resultText, 'PIPELINE_BUG_ISSUES');
}

export function flattenMvpQueue(stages: number[][]): number[] {
  const seen = new Set<number>();
  const flat: number[] = [];

  for (const stage of stages) {
    for (const n of stage) {
      if (seen.has(n)) {
        continue;
      }

      seen.add(n);
      flat.push(n);
    }
  }

  return flat;
}

export function formatMvpQueueStages(stages: number[][]): string {
  return stages
    .map((stage) =>
      stage.filter((n) => Number.isSafeInteger(n) && n > 0).join('+'),
    )
    .filter((item) => item.length > 0)
    .join(',');
}

function parseMvpQueueText(value: string): number[][] | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.toLowerCase() === 'none') {
    return [];
  }

  if (!/^[#\d+,\s]+$/.test(trimmed)) {
    return null;
  }

  const stages: number[][] = [];
  const seen = new Set<number>();

  for (const stageText of trimmed.split(',')) {
    if (!stageText.trim()) {
      continue;
    }

    const stage: number[] = [];

    for (const part of stageText.split('+')) {
      const n = Number(part.trim().replace(/^#/, ''));

      if (!Number.isSafeInteger(n) || n <= 0) {
        return null;
      }

      if (seen.has(n)) {
        continue;
      }

      seen.add(n);
      stage.push(n);
    }

    if (stage.length === 0) {
      continue;
    }

    stages.push(stage);
  }

  return stages.length > 0 ? stages : null;
}

export function extractMvpTaskStages(
  resultText: string | null,
): number[][] | null {
  const marker = resultText?.match(/^PIPELINE_MVP_TASKS:\s*(.+?)\s*$/im);

  if (!marker) {
    return null;
  }

  return parseMvpQueueText(marker[1]);
}

export function extractMvpTaskIssues(
  resultText: string | null,
): number[] | null {
  const stages = extractMvpTaskStages(resultText);

  if (stages === null) {
    return null;
  }

  return flattenMvpQueue(stages);
}

export function extractReleaseTag(resultText: string | null): string | null {
  const marker = resultText?.match(
    /^PIPELINE_RELEASE_TAG:\s*(v?[0-9]+\.[0-9]+\.[0-9]+)\s*$/im,
  );

  if (!marker) {
    return null;
  }

  const tag = marker[1];

  return tag.startsWith('v') ? tag : `v${tag}`;
}

export function extractReleasePrNumbers(
  resultText: string | null,
): number[] | null {
  const marker = resultText?.match(
    /^PIPELINE_PR_NUMBERS:\s*(none|(?:#?\d+(?:\s*,\s*#?\d+)*))\s*$/im,
  );

  if (!marker) {
    return null;
  }

  if (marker[1].toLowerCase() === 'none') {
    return [];
  }

  return [
    ...new Set(
      marker[1]
        .split(',')
        .map((value) => Number(value.trim().replace(/^#/, '')))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}

export function extractReleaseChangelog(
  resultText: string | null,
): string | null {
  if (!resultText) {
    return null;
  }

  const block = resultText.match(
    /PIPELINE_CHANGELOG_BEGIN\s*\n([\s\S]*?)\nPIPELINE_CHANGELOG_END/i,
  );

  if (!block) {
    return null;
  }

  const body = block[1].trim();

  return body.length > 0 ? body : null;
}

export function decideReleaseManagerOutcome(
  runStatus: 'finished' | 'error' | 'startup_error',
  resultText: string | null,
  tag: string | null,
  changelog: string | null,
  expectedTag: string | null = null,
): ReleaseManagerDecision {
  if (runStatus !== 'finished') {
    return 'needs-human';
  }

  const marker = resultText?.match(
    /^PIPELINE_LABELS:\s*(needs-human|released)\s*$/im,
  );

  if (!marker) {
    return 'needs-human';
  }

  const requested = marker[1].toLowerCase() as ReleaseManagerDecision;

  if (requested === 'needs-human') {
    return 'needs-human';
  }

  if (tag && changelog && (!expectedTag || tag === expectedTag)) {
    return 'released';
  }

  return 'needs-human';
}

/** Completed developer starts allowed before needs-human (4th attempt
 * blocked). */
export const MAX_FIX_ROUNDS = 3;

export function parseFixRound(body: string | null): number | null {
  if (!body) {
    return null;
  }

  const marker = body.match(/^(?:<!--\s*)?fix-round:\s*(\d+)\s*(?:-->)?\s*$/im);

  if (!marker) {
    return null;
  }

  const value = Number(marker[1]);

  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** True when another developer start is not allowed (already used MAX
 * rounds). */
export function fixRoundBlocksDeveloper(body: string | null): boolean {
  const round = parseFixRound(body) ?? 0;

  return round >= MAX_FIX_ROUNDS;
}

export function upsertFixRoundInBody(
  body: string | null,
  round: number,
): string {
  const line = `fix-round: ${round}`;
  const html = `<!-- pipeline:fix-round:${round} -->`;
  const base = (body ?? '')
    .replace(/^(?:<!--\s*)?fix-round:\s*\d+\s*(?:-->)?\s*$/gim, '')
    .replace(/<!--\s*pipeline:fix-round:\d+\s*-->/gi, '')
    .trimEnd();

  if (!base) {
    return `${line}\n${html}`;
  }

  return `${base}\n\n${line}\n${html}`;
}

export function parseChildBugIssues(body: string | null): number[] {
  if (!body) {
    return [];
  }

  const marker = body.match(/<!--\s*pipeline:child-bugs:([0-9,\s]+)\s*-->/i);

  if (!marker) {
    return [];
  }

  return [
    ...new Set(
      marker[1]
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}

function parsePipelineHtmlList(body: string | null, key: string): number[] {
  if (!body) {
    return [];
  }

  const marker = body.match(
    new RegExp(`<!--\\s*pipeline:${key}:([0-9,\\s]+)\\s*-->`, 'i'),
  );

  if (!marker) {
    return [];
  }

  return [
    ...new Set(
      marker[1]
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}

function upsertPipelineHtmlList(
  body: string | null,
  key: string,
  issues: number[],
): string {
  const unique = [
    ...new Set(issues.filter((n) => Number.isSafeInteger(n) && n > 0)),
  ];
  const marker = `<!-- pipeline:${key}:${unique.join(',')} -->`;
  const base = (body ?? '')
    .replace(new RegExp(`<!--\\s*pipeline:${key}:[0-9,\\s]*\\s*-->`, 'gi'), '')
    .trimEnd();

  if (unique.length === 0) {
    return base;
  }

  if (!base) {
    return marker;
  }

  return `${base}\n\n${marker}`;
}

export function parseMvpTaskIssues(body: string | null): number[] {
  return parsePipelineHtmlList(body, 'mvp-tasks');
}

export function upsertMvpTaskIssuesInBody(
  body: string | null,
  tasks: number[],
): string {
  return upsertPipelineHtmlList(body, 'mvp-tasks', tasks);
}

export function parseMvpQueueStages(body: string | null): number[][] {
  if (!body) {
    return [];
  }

  const marker = body.match(/<!--\s*pipeline:mvp-queue:([0-9+#,\s]+)\s*-->/i);

  if (!marker) {
    return [];
  }

  return parseMvpQueueText(marker[1]) ?? [];
}

export function parseMvpQueueIssues(body: string | null): number[] {
  return flattenMvpQueue(parseMvpQueueStages(body));
}

export function upsertMvpQueueIssuesInBody(
  body: string | null,
  stages: number[][],
): string {
  const formatted = formatMvpQueueStages(stages);
  const marker = `<!-- pipeline:mvp-queue:${formatted} -->`;
  const base = (body ?? '')
    .replace(/<!--\s*pipeline:mvp-queue:[0-9+#,\s]*\s*-->/gi, '')
    .trimEnd();

  if (!formatted) {
    return base;
  }

  if (!base) {
    return marker;
  }

  return `${base}\n\n${marker}`;
}

/** Предыдущая задача MVP ещё занимает слот developer. */
export function mvpQueueHoldsDeveloper(labels: readonly string[]): boolean {
  return (
    labels.includes('needs-plan') ||
    labels.includes('in-analysis') ||
    labels.includes('ready-for-dev') ||
    labels.includes('in-dev') ||
    labels.includes('needs-human')
  );
}

/** Повторный analyst на MVP: Q&A (needs-plan) или создание задач
 * (approved). Не сбрасывать in-flight. */
export function shouldResetMvpAnalystJob(params: {
  labels: string[];
  jobStatus: JobStatus | null | undefined;
}): boolean {
  if (!isMvpIssue(params.labels)) {
    return false;
  }

  const waiting =
    params.labels.includes('needs-plan') || params.labels.includes('approved');

  if (!waiting || !params.jobStatus) {
    return false;
  }

  return params.jobStatus !== 'running' && params.jobStatus !== 'queued';
}

/** Повтор роли после сбоя: человек вернул trigger-лейбл
 * (analyst: `needs-plan`, developer: `ready-for-dev`, tester:
 * `in-qa`). Не трогать in-flight и успешный `finished`. */
export function shouldResetFailedRoleJob(params: {
  triggerLabel: string;
  labels: string[];
  jobStatus: JobStatus | null | undefined;
  decision: string | null | undefined;
}): boolean {
  if (!params.labels.includes(params.triggerLabel)) {
    return false;
  }

  if (params.labels.includes('needs-human')) {
    return false;
  }

  if (!params.jobStatus) {
    return false;
  }

  if (params.jobStatus === 'running' || params.jobStatus === 'queued') {
    return false;
  }

  if (params.jobStatus === 'error' || params.jobStatus === 'startup_error') {
    return true;
  }

  return params.jobStatus === 'finished' && params.decision === 'needs-human';
}

/** `in-dev` без живого джоба: облачный агент мог открыть PR после
 * drop/рестарта. Не трогать in-flight. */
export function isStaleInDevHandoffCandidate(params: {
  labels: string[];
  jobStatus: JobStatus | null | undefined;
}): boolean {
  if (!hasWorkType(params.labels)) {
    return false;
  }

  if (!params.labels.includes('in-dev')) {
    return false;
  }

  if (params.labels.includes('needs-human')) {
    return false;
  }

  if (params.jobStatus === 'running' || params.jobStatus === 'queued') {
    return false;
  }

  return true;
}

/** Залипший `in-dev` + открытый Fixes PR → `in-qa` без агента. */
export function shouldPromoteStaleInDev(params: {
  labels: string[];
  jobStatus: JobStatus | null | undefined;
  hasOpenFixPr: boolean;
}): boolean {
  return params.hasOpenFixPr && isStaleInDevHandoffCandidate(params);
}

export function upsertChildBugIssuesInBody(
  body: string | null,
  bugs: number[],
): string {
  const unique = [
    ...new Set(bugs.filter((n) => Number.isSafeInteger(n) && n > 0)),
  ];
  const marker = `<!-- pipeline:child-bugs:${unique.join(',')} -->`;
  const base = (body ?? '')
    .replace(/<!--\s*pipeline:child-bugs:[0-9,\s]*\s*-->/gi, '')
    .trimEnd();

  if (unique.length === 0) {
    return base;
  }

  if (!base) {
    return marker;
  }

  return `${base}\n\n${marker}`;
}

export function parseRelatedParentIssue(body: string | null): number | null {
  if (!body) {
    return null;
  }

  const marker = body.match(/Related\s+to\s+#(\d+)/i);

  if (!marker) {
    return null;
  }

  const value = Number(marker[1]);

  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function isChildBugCandidate(issue: {
  labels: string[];
  body: string | null;
}): boolean {
  return (
    issue.labels.includes('bug') &&
    issue.labels.includes('needs-plan') &&
    parseRelatedParentIssue(issue.body) !== null
  );
}

/** Группы sibling child bugs (один parent) для параллельного analyst;
 * остальные — по одной issue. */
export function groupAnalystIssuesByParent<
  T extends {
    number: number;
    labels: string[];
    body: string | null;
  },
>(issues: T[]): T[][] {
  const siblingByParent = new Map<number, T[]>();
  const standalone: T[] = [];

  for (const issue of issues) {
    if (isChildBugCandidate(issue)) {
      const parent = parseRelatedParentIssue(issue.body)!;
      const group = siblingByParent.get(parent) ?? [];

      group.push(issue);
      siblingByParent.set(parent, group);
    } else {
      standalone.push(issue);
    }
  }

  const batches: T[][] = [...siblingByParent.values()];

  for (const issue of standalone) {
    batches.push([issue]);
  }

  return batches;
}

/** `needs-human` не финиш: квота / уточнение на ребёнке не должно
 * снимать блок re-QA родителя. */
const CHILD_DONE_LABELS = ['qa-passed', 'deployed'] as const;

export function childBugStillOpen(
  labels: string[],
  state: GitHubIssueState,
): boolean {
  return (
    state !== 'closed' &&
    !CHILD_DONE_LABELS.some((label) => labels.includes(label))
  );
}

/** Отдельный open Fixes PR ребёнка — не тот же номер, что PR родителя. */
export function childHasDistinctOpenFixPr(
  childPrNumber: number | null,
  parentPrNumber: number | null,
): boolean {
  return childPrNumber !== null && childPrNumber !== parentPrNumber;
}

/** Отдельный open Fixes PR блокирует re-QA родителя, даже если ребёнок
 * уже qa-passed. Тот же PR, что у родителя (`Fixes #parent` +
 * `Fixes #child`), re-QA не держит. */
export function childBlocksParentReQa(
  labels: string[],
  state: GitHubIssueState,
  hasDistinctOpenFixPr: boolean,
): boolean {
  return hasDistinctOpenFixPr || childBugStillOpen(labels, state);
}

/** Дочерний qa-passed без открытого PR, фикс уже смержен — можно закрыть
 * issue. */
export function shouldCloseMergedChildIssue(params: {
  body: string | null;
  labels: string[];
  hasOpenFixPr: boolean;
  hasMergedFixPr: boolean;
}): boolean {
  return (
    parseRelatedParentIssue(params.body) !== null &&
    params.labels.includes('qa-passed') &&
    !params.hasOpenFixPr &&
    params.hasMergedFixPr
  );
}

const JOB_STATUS_TO_UI: Record<JobStatus, UiJobStatus> = {
  queued: 'queued',
  running: 'running',
  error: 'failed',
  startup_error: 'failed',
  finished: 'finished',
};

export function mapJobToUiStatus(
  job: Pick<Job, 'status' | 'decision'>,
): UiJobStatus {
  if (job.status === 'finished' && job.decision === 'needs-human') {
    return 'clarification';
  }

  return JOB_STATUS_TO_UI[job.status];
}
