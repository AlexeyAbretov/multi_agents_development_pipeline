import type { Role } from "./types.js";

export function inFlightKey(issue: number, role: Role): string {
  return `${issue}:${role}`;
}

/** Dev и QA не ждут аналитика / RM в том же тике: если есть задача — стартуют сразу. */
const ROLE_DISPATCH_ORDER: Record<Role, number> = {
  developer: 0,
  tester: 1,
  analyst: 2,
  "release-manager": 3,
};

export const UNGATED_ROLES: ReadonlyArray<Role> = ["developer", "tester"];

export type DispatchWork<T> = { issue: T; role: Role };

export function orderWorkForDispatch<T>(work: Array<DispatchWork<T>>): Array<DispatchWork<T>> {
  return [...work].sort((a, b) => ROLE_DISPATCH_ORDER[a.role] - ROLE_DISPATCH_ORDER[b.role]);
}

/**
 * Что запускать в этом тике. Уже in-flight пары `(issue, role)` пропускаем —
 * полл не должен ждать `run.wait()` и не должен стартовать второго агента на ту же пару.
 */
export function selectJobsToLaunch<T extends { number: number }>(
  work: Array<DispatchWork<T>>,
  inFlight: ReadonlySet<string>,
): Array<DispatchWork<T>> {
  const selected: Array<DispatchWork<T>> = [];
  const claimed = new Set<string>();
  for (const item of orderWorkForDispatch(work)) {
    const key = inFlightKey(item.issue.number, item.role);
    if (inFlight.has(key) || claimed.has(key)) {
      continue;
    }
    claimed.add(key);
    selected.push(item);
  }
  return selected;
}
