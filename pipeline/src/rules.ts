import type { Role } from "./types.js";
import { isRegressionIssue } from "./schedule-rules.js";

export type AnalystDecision = "ready-for-dev" | "needs-human";
export type DeveloperDecision = "in-qa" | "needs-human";
export type TesterDecision = "in-qa" | "qa-passed" | "needs-human";
export type ReleaseManagerDecision = "released" | "needs-human";

export function roleForLabels(labels: string[], body: string | null = null): Role | null {
  if (labels.includes("needs-human") || labels.includes("in-analysis")) {
    return null;
  }
  const regression = isRegressionIssue(labels, body);
  const hasType = labels.includes("bug") || labels.includes("feature");
  if (!hasType && !regression) {
    return null;
  }
  if (hasType && labels.includes("needs-plan") && !labels.includes("ready-for-dev")) {
    return "analyst";
  }
  if (
    hasType &&
    labels.includes("ready-for-dev") &&
    !labels.includes("needs-plan") &&
    !labels.includes("in-dev") &&
    !labels.includes("in-qa")
  ) {
    return "developer";
  }
  if (
    labels.includes("in-qa") &&
    !labels.includes("qa-in-progress") &&
    !labels.includes("qa-passed")
  ) {
    return "tester";
  }
  if (regression && labels.includes("qa-passed")) {
    return "release-manager";
  }
  return null;
}

export function decideAnalystOutcome(
  runStatus: "finished" | "error" | "startup_error",
  resultText: string | null,
): AnalystDecision {
  if (runStatus !== "finished") {
    return "needs-human";
  }

  const marker = resultText?.match(/PIPELINE_LABELS:\s*(needs-human|ready-for-dev)/i);
  if (marker) {
    return marker[1].toLowerCase() as AnalystDecision;
  }

  if (resultText && /needs-human/i.test(resultText)) {
    return "needs-human";
  }

  return "ready-for-dev";
}

export function decideDeveloperOutcome(
  runStatus: "finished" | "error" | "startup_error",
  hasOpenFixPr: boolean,
): DeveloperDecision {
  if (hasOpenFixPr) {
    return "in-qa";
  }
  if (runStatus !== "finished") {
    return "needs-human";
  }
  return "needs-human";
}

export function decideTesterOutcome(
  runStatus: "finished" | "error" | "startup_error",
  resultText: string | null,
  bugIssues: number[] | null,
): TesterDecision {
  if (runStatus !== "finished") {
    return "needs-human";
  }
  const marker = resultText?.match(
    /^PIPELINE_LABELS:\s*(needs-human|in-qa|qa-passed)\s*$/im,
  );
  if (!marker || bugIssues === null) {
    return "needs-human";
  }
  const requested = marker[1].toLowerCase() as TesterDecision;
  if (requested === "needs-human") {
    return "needs-human";
  }
  if (bugIssues.length === 0 && requested === "qa-passed") {
    return "qa-passed";
  }
  if (bugIssues.length > 0 && requested === "in-qa") {
    return "in-qa";
  }
  return "needs-human";
}

/** Максимум дочерних bug-issues за один прогон тестировщика (корень). */
export const MAX_TESTER_CHILD_BUGS = 2;

export type TesterBugHandoff = "ok" | "too-many" | "grandchild";

/** Глубина дерева QA = 1: дети не плодят внуков; на корне не больше MAX багов. */
export function classifyTesterBugHandoff(
  parentBody: string | null,
  bugIssues: number[],
): TesterBugHandoff {
  if (bugIssues.length === 0) {
    return "ok";
  }
  if (parseRelatedParentIssue(parentBody) !== null) {
    return "grandchild";
  }
  if (bugIssues.length > MAX_TESTER_CHILD_BUGS) {
    return "too-many";
  }
  return "ok";
}

export function testerBugIssues(resultText: string | null): number[] | null {
  const marker = resultText?.match(
    /^PIPELINE_BUG_ISSUES:\s*(none|(?:#?\d+(?:\s*,\s*#?\d+)*))\s*$/im,
  );
  if (!marker) {
    return null;
  }
  if (marker[1].toLowerCase() === "none") {
    return [];
  }
  return [
    ...new Set(
      marker[1]
        .split(",")
        .map((value) => Number(value.trim().replace(/^#/, "")))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}

export function releaseTag(resultText: string | null): string | null {
  const marker = resultText?.match(/^PIPELINE_RELEASE_TAG:\s*(v?[0-9]+\.[0-9]+\.[0-9]+)\s*$/im);
  if (!marker) {
    return null;
  }
  const tag = marker[1];
  return tag.startsWith("v") ? tag : `v${tag}`;
}

export function releasePrNumbers(resultText: string | null): number[] | null {
  const marker = resultText?.match(
    /^PIPELINE_PR_NUMBERS:\s*(none|(?:#?\d+(?:\s*,\s*#?\d+)*))\s*$/im,
  );
  if (!marker) {
    return null;
  }
  if (marker[1].toLowerCase() === "none") {
    return [];
  }
  return [
    ...new Set(
      marker[1]
        .split(",")
        .map((value) => Number(value.trim().replace(/^#/, "")))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}

export function releaseChangelog(resultText: string | null): string | null {
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
  runStatus: "finished" | "error" | "startup_error",
  resultText: string | null,
  tag: string | null,
  changelog: string | null,
  expectedTag: string | null = null,
): ReleaseManagerDecision {
  if (runStatus !== "finished") {
    return "needs-human";
  }
  const marker = resultText?.match(/^PIPELINE_LABELS:\s*(needs-human|released)\s*$/im);
  if (!marker) {
    return "needs-human";
  }
  const requested = marker[1].toLowerCase() as ReleaseManagerDecision;
  if (requested === "needs-human") {
    return "needs-human";
  }
  if (tag && changelog && (!expectedTag || tag === expectedTag)) {
    return "released";
  }
  return "needs-human";
}

export function prFixesIssue(pr: {
  title: string;
  body: string | null;
  headRef: string;
}, issue: number): boolean {
  const text = `${pr.title}\n${pr.body ?? ""}`;
  const keywords = new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue}\\b`,
    "i",
  );
  if (keywords.test(text)) {
    return true;
  }
  return new RegExp(`^issue/${issue}(?:-|$)`).test(pr.headRef);
}

/** Completed developer starts allowed before needs-human (4th attempt blocked). */
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

/** True when another developer start is not allowed (already used MAX rounds). */
export function fixRoundBlocksDeveloper(body: string | null): boolean {
  const round = parseFixRound(body) ?? 0;
  return round >= MAX_FIX_ROUNDS;
}

export function upsertFixRoundInBody(body: string | null, round: number): string {
  const line = `fix-round: ${round}`;
  const html = `<!-- pipeline:fix-round:${round} -->`;
  const base = (body ?? "")
    .replace(/^(?:<!--\s*)?fix-round:\s*\d+\s*(?:-->)?\s*$/gim, "")
    .replace(/<!--\s*pipeline:fix-round:\d+\s*-->/gi, "")
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
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}

export function upsertChildBugIssuesInBody(body: string | null, bugs: number[]): string {
  const unique = [...new Set(bugs.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const marker = `<!-- pipeline:child-bugs:${unique.join(",")} -->`;
  const base = (body ?? "").replace(/<!--\s*pipeline:child-bugs:[0-9,\s]*\s*-->/gi, "").trimEnd();
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
    issue.labels.includes("bug") &&
    issue.labels.includes("needs-plan") &&
    parseRelatedParentIssue(issue.body) !== null
  );
}

/** Группы sibling child bugs (один parent) для параллельного analyst; остальные — по одной issue. */
export function groupAnalystIssuesByParent<T extends { number: number; labels: string[]; body: string | null }>(
  issues: T[],
): T[][] {
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

/** Child is still in the fix pipeline (blocks parent re-QA). */
export function childBugStillOpen(labels: string[], state: "open" | "closed"): boolean {
  if (state === "closed") {
    return false;
  }
  if (labels.includes("qa-passed") || labels.includes("deployed")) {
    return false;
  }
  if (labels.includes("needs-human")) {
    return false;
  }
  return true;
}

/** Open Fixes PR блокирует re-QA родителя, даже если ребёнок уже qa-passed. */
export function childBlocksParentReQa(
  labels: string[],
  state: "open" | "closed",
  hasOpenFixPr: boolean,
): boolean {
  if (hasOpenFixPr) {
    return true;
  }
  return childBugStillOpen(labels, state);
}

/** Дочерний qa-passed без открытого PR, фикс уже смержен — можно закрыть issue. */
export function shouldCloseMergedChildIssue(params: {
  body: string | null;
  labels: string[];
  hasOpenFixPr: boolean;
  hasMergedFixPr: boolean;
}): boolean {
  if (parseRelatedParentIssue(params.body) === null) {
    return false;
  }
  if (!params.labels.includes("qa-passed")) {
    return false;
  }
  if (params.hasOpenFixPr) {
    return false;
  }
  return params.hasMergedFixPr;
}
