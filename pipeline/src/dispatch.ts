import type { Role } from "./types";

/** Идентичность активного задания: одно облако на пару `(issue, role)`. */
export const inFlightKey = (issue: number, role: Role): string => {
  return `${issue}:${role}`;
};

export type DispatchWork<T> = { issue: T; role: Role };

/**
 * Что запускать в этом тике. Уже in-flight пары `(issue, role)` пропускаем —
 * полл не должен ждать `run.wait()` и не должен стартовать второго агента на ту же пару.
 * Роли друг друга не гейтят: каждая оставшаяся пара стартует в том же тике.
 */
export const selectJobsToLaunch = <T extends { number: number }>(
  work: Array<DispatchWork<T>>,
  inFlight: ReadonlySet<string>,
): Array<DispatchWork<T>> => {
  const selected: Array<DispatchWork<T>> = [];
  const claimed = new Set<string>();

  for (const item of work) {
    const key = inFlightKey(item.issue.number, item.role);

    if (inFlight.has(key) || claimed.has(key)) {
      continue;
    }

    claimed.add(key);
    selected.push(item);
  }

  return selected;
};
