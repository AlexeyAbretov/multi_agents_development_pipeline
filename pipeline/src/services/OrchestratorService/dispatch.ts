import type { Role } from '@types';

import {
  flattenMvpQueue,
  mvpQueueHoldsDeveloper,
  parseMvpQueueStages,
} from './rules';

/** Идентичность активного задания: одно облако на пару `(issue, role)`. */
export function inFlightKey(issue: number, role: Role): string {
  return `${issue}:${role}`;
}

export type DispatchIssue = {
  number: number;
  body?: string | null;
  labels?: readonly string[];
};

export type DispatchWork<T extends DispatchIssue = DispatchIssue> = {
  issue: T;
  role: Role;
};

function issueCatalog<T extends DispatchIssue>(
  catalog: readonly T[],
  work: Array<DispatchWork<T>>,
): Map<number, T> {
  const byNumber = new Map<number, T>();

  for (const issue of catalog) {
    byNumber.set(issue.number, issue);
  }

  for (const item of work) {
    byNumber.set(item.issue.number, item.issue);
  }

  return byNumber;
}

function mvpQueueForIssue<T extends DispatchIssue>(
  issue: T,
  byNumber: Map<number, T>,
): number[][] {
  const own = parseMvpQueueStages(issue.body ?? null);

  if (own.length > 0) {
    return own;
  }

  for (const other of byNumber.values()) {
    const queue = parseMvpQueueStages(other.body ?? null);

    if (flattenMvpQueue(queue).includes(issue.number)) {
      return queue;
    }
  }

  return [];
}

/** Номер задачи предыдущего этапа MVP, из-за которой developer ещё
 * нельзя стартовать. */
export function mvpQueueDeveloperWait<T extends DispatchIssue>(
  issue: T,
  byNumber: Map<number, T>,
  inFlight: ReadonlySet<string>,
): number | null {
  const stages = mvpQueueForIssue(issue, byNumber);
  const stageIndex = stages.findIndex((stage) => stage.includes(issue.number));

  if (stageIndex <= 0) {
    return null;
  }

  const ahead = flattenMvpQueue(stages.slice(0, stageIndex));

  for (const previous of ahead) {
    if (inFlight.has(inFlightKey(previous, 'developer'))) {
      return previous;
    }

    const prev = byNumber.get(previous);

    if (!prev) {
      continue;
    }

    if (mvpQueueHoldsDeveloper(prev.labels ?? [])) {
      return previous;
    }
  }

  return null;
}

/**
 * Что запускать в этом тике. Уже in-flight пары `(issue, role)` пропускаем.
 * Роли друг друга не гейтят, кроме developer на `mvp-queue`: этапы по
 * запятой, внутри этапа (`+`) параллельно.
 */
export function selectJobsToLaunch<T extends DispatchIssue>(
  work: Array<DispatchWork<T>>,
  inFlight: ReadonlySet<string>,
  catalog: readonly T[] = [],
): Array<DispatchWork<T>> {
  const selected: Array<DispatchWork<T>> = [];
  const claimed = new Set<string>();
  const byNumber = issueCatalog(catalog, work);

  for (const item of work) {
    const key = inFlightKey(item.issue.number, item.role);

    if (inFlight.has(key) || claimed.has(key)) {
      continue;
    }

    if (
      item.role === 'developer' &&
      mvpQueueDeveloperWait(item.issue, byNumber, inFlight) !== null
    ) {
      continue;
    }

    claimed.add(key);
    selected.push(item);
  }

  return selected;
}
