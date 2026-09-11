/**
 * Calendar date YYYY-MM-DD in an IANA time zone
 * (GitHub milestone due_on is a date).
 */
export function calendarDateInTimeZone(
  date: Date = new Date(),
  timeZone = "Europe/Moscow",
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}

/**
 * @deprecated use calendarDateInTimeZone; kept as UTC snapshot
 * for older call sites.
 */
export function utcDateString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function dueDay(dueOn: string | null | undefined): string | null {
  if (!dueOn) {
    return null;
  }

  const day = dueOn.slice(0, 10);

  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function dayDiff(fromDay: string, toDay: string): number {
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`);

  return Math.round((toMs - fromMs) / 86_400_000);
}

/**
 * Days from today (in timeZone) until milestone due date.
 * 0 = today, 1 = tomorrow, negative = past.
 */
export function daysUntilDue(
  dueOn: string | null | undefined,
  timeZone = "Europe/Moscow",
  today: Date = new Date(),
): number | null {
  const day = dueDay(dueOn);

  if (!day) {
    return null;
  }

  return dayDiff(calendarDateInTimeZone(today, timeZone), day);
}

export function isMilestoneDueOn(
  dueOn: string | null | undefined,
  today: Date = new Date(),
  timeZone = "Europe/Moscow",
): boolean {
  return daysUntilDue(dueOn, timeZone, today) === 0;
}

/**
 * Milestone title → git/release tag. Only `vN.N.N`.
 */
export function tagFromMilestoneTitle(title: string): string | null {
  const trimmed = title.trim();

  return /^v\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : null;
}

export function isReleaseMilestoneTitle(title: string): boolean {
  return tagFromMilestoneTitle(title) !== null;
}

export function regressionIssueTitle(tag: string): string {
  return `Регресс ${tag}`;
}

export function regressionMarker(milestoneId: number): string {
  return `<!-- pipeline:regression:${milestoneId} -->`;
}

export function parseRegressionMilestoneId(body: string | null): number | null {
  if (!body) {
    return null;
  }

  const marker = body.match(/<!--\s*pipeline:regression:(\d+)\s*-->/i);

  if (!marker) {
    return null;
  }

  const value = Number(marker[1]);

  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function regressionIssueBody(milestoneId: number, tag: string): string {
  return [
    regressionMarker(milestoneId),
    "",
    `Служебная issue регресса ветки \`main\` перед релизом \`${tag}\`.`,
    "Не фича и не баг продукта: тестировщик проверяет HEAD `main`.",
    "Баги регресса — отдельные корневые `bug` в этом milestone, " +
      "без `Related to #` на эту issue.",
  ].join("\n");
}

export function bodyHasRegressionMarker(
  body: string | null,
  milestoneId: number,
): boolean {
  return parseRegressionMilestoneId(body) === milestoneId;
}

export function isRegressionIssue(
  labels: string[],
  body: string | null = null,
): boolean {
  return (
    labels.includes("regression") || parseRegressionMilestoneId(body) !== null
  );
}

export function isReleaseWorkIssue(labels: string[]): boolean {
  return labels.includes("bug") || labels.includes("feature");
}

export function blockedNoReleaseMarker(milestoneId: number): string {
  return `<!-- pipeline:blocked-no-release:${milestoneId} -->`;
}

export function bodyHasBlockedNoReleaseMarker(
  body: string | null,
  milestoneId: number,
): boolean {
  if (!body) {
    return false;
  }

  return body.includes(blockedNoReleaseMarker(milestoneId));
}

export function blockedNoReleaseComment(
  milestoneTitle: string,
  milestoneId: number,
): string {
  return [
    blockedNoReleaseMarker(milestoneId),
    `Пайплайн: milestone \`${milestoneTitle}\` due сегодня, ` +
      "но **published Release / tag нет**.",
    "`blocked: no release` — локальный compose / deployer не запускается.",
    "Дождитесь зелёного регресса `main` и релиз-менеджера " +
      "или сдвиньте `due_on`.",
  ].join("\n");
}

export function duplicateDueMarker(day: string): string {
  return `<!-- pipeline:blocked-duplicate-due:${day} -->`;
}

export function duplicateDueComment(day: string, titles: string[]): string {
  return [
    duplicateDueMarker(day),
    `Пайплайн: сегодня (${day}) due у нескольких ` +
      "release-milestones: " +
      titles.map((title) => `\`${title}\``).join(", ") +
      ".",
    "Релиз-менеджер не стартует, нужен человек. " +
      "Оставьте один milestone с due сегодня.",
  ].join("\n");
}

export type ReleaseGate =
  | "ok"
  | "not-regression"
  | "bad-title"
  | "not-due-today"
  | "duplicate-due"
  | "open-work"
  | "already-released"
  | "regression-not-passed"
  | "nothing-to-release";

export function decideReleaseGate(params: {
  labels: string[];
  body?: string | null;
  milestoneTitle: string | null;
  dueOn: string | null;
  timeZone: string;
  dueTodayCount: number;
  hasOpenWorkItems: boolean;
  releaseExists: boolean;
  nothingToRelease?: boolean;
  now?: Date;
}): ReleaseGate {
  if (!isRegressionIssue(params.labels, params.body ?? null)) {
    return "not-regression";
  }

  if (!params.labels.includes("qa-passed")) {
    return "regression-not-passed";
  }

  const tag = params.milestoneTitle
    ? tagFromMilestoneTitle(params.milestoneTitle)
    : null;

  if (!tag) {
    return "bad-title";
  }

  if (params.releaseExists) {
    return "already-released";
  }

  if (params.nothingToRelease) {
    return "nothing-to-release";
  }

  if (params.dueTodayCount > 1) {
    return "duplicate-due";
  }

  if (daysUntilDue(params.dueOn, params.timeZone, params.now) !== 0) {
    return "not-due-today";
  }

  if (params.hasOpenWorkItems) {
    return "open-work";
  }

  return "ok";
}

export function previousReleaseTag(
  releases: Array<{ tag_name: string; published_at: string | null }>,
  currentTag: string,
): string | null {
  const others = releases
    .filter((item) => item.tag_name !== currentTag)
    .sort((a, b) => {
      const aTime = a.published_at ? Date.parse(a.published_at) : 0;
      const bTime = b.published_at ? Date.parse(b.published_at) : 0;

      return bTime - aTime;
    });

  return others[0]?.tag_name ?? null;
}

/**
 * No previous published tag → first release, not empty.
 * Unknown aheadBy → do not skip.
 */
export function isEmptySincePreviousRelease(params: {
  previousTag: string | null;
  aheadBy: number | null;
}): boolean {
  if (!params.previousTag) {
    return false;
  }

  if (params.aheadBy === null) {
    return false;
  }

  return params.aheadBy <= 0;
}

export function nothingToReleaseMarker(milestoneId: number): string {
  return `<!-- pipeline:nothing-to-release:${milestoneId} -->`;
}

export function nothingToReleaseComment(
  milestoneTitle: string,
  previousTag: string,
  milestoneId: number,
): string {
  return [
    nothingToReleaseMarker(milestoneId),
    `Пайплайн: с прошлого релиза \`${previousTag}\` ` +
      "в `main` **нет новых коммитов**.",
    `GitHub Release \`${milestoneTitle}\` не создан. Milestone закрыт.`,
  ].join("\n");
}

export function upsertNothingToReleaseDescription(
  existing: string | null,
  comment: string,
): string {
  const markerLine = comment.split("\n")[0] ?? "";

  if (existing && markerLine && existing.includes(markerLine)) {
    return existing;
  }

  const base = (existing ?? "").trimEnd();

  if (!base) {
    return comment;
  }

  return `${base}\n\n${comment}`;
}

/**
 * True when due today and RM cannot run — notify,
 * but not while regression is still in progress.
 */
export function shouldNotifyBlockedNoRelease(params: {
  releaseExists: boolean;
  regressionLabels: string[] | null;
  hasOpenWorkItems: boolean;
}): boolean {
  if (params.releaseExists) {
    return false;
  }

  const labels = params.regressionLabels;

  if (!labels) {
    return false;
  }

  if (labels.includes("needs-human")) {
    return true;
  }

  if (labels.includes("qa-passed") && params.hasOpenWorkItems) {
    return true;
  }

  return false;
}
