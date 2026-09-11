import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import { runCloudAgent } from "./cursor.js";
import { GitHubClient, agentResultComment, jobComment, type GitHubIssue, type GitHubPull } from "./github.js";
import { JobStore } from "./jobs.js";
import { jobLog } from "./log.js";
import {
  childBlocksParentReQa,
  classifyTesterBugHandoff,
  decideAnalystOutcome,
  decideDeveloperOutcome,
  decideReleaseManagerOutcome,
  decideTesterOutcome,
  fixRoundBlocksDeveloper,
  groupAnalystIssuesByParent,
  MAX_FIX_ROUNDS,
  MAX_TESTER_CHILD_BUGS,
  parseChildBugIssues,
  parseFixRound,
  parseRelatedParentIssue,
  shouldCloseMergedChildIssue,
  extractReleaseChangelog,
  extractReleaseTag,
  roleForLabels,
  extractTesterBugIssues,
  upsertChildBugIssuesInBody,
  upsertFixRoundInBody,
} from "./rules.js";
import {
  decideReleaseGate,
  daysUntilDue,
  isRegressionIssue,
  isReleaseWorkIssue,
  tagFromMilestoneTitle,
} from "./schedule-rules.js";
import type { Role } from "./types.js";
import { inFlightKey, selectJobsToLaunch } from "./dispatch.js";
import { closeEmptyRelease } from "./schedule.js";

export function startPoller(
  config: Config,
  logger: FastifyBaseLogger,
  store: JobStore,
): { stop: () => void } {
  const github = new GitHubClient(config);
  let listing = false;
  const inFlight = new Set<string>();

  const tick = (): void => {
    if (listing) {
      jobLog(logger, {}, "poll skip: previous tick still running");

      return;
    }

    listing = true;
    void pollOnce(config, logger, store, github, inFlight).finally(() => {
      listing = false;
    });
  };

  tick();
  const timer = setInterval(tick, config.POLL_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

function mergeIssues(groups: GitHubIssue[][]): GitHubIssue[] {
  const byNumber = new Map<number, GitHubIssue>();

  for (const group of groups) {
    for (const issue of group) {
      byNumber.set(issue.number, issue);
    }
  }

  return [...byNumber.values()];
}

async function pollOnce(
  config: Config,
  logger: FastifyBaseLogger,
  store: JobStore,
  github: GitHubClient,
  inFlight: Set<string>,
): Promise<void> {
  jobLog(logger, {}, "poll tick");

  if (!config.GITHUB_TOKEN || !config.GITHUB_REPO) {
    jobLog(logger, {}, "poll skip: GITHUB_TOKEN or GITHUB_REPO empty");

    return;
  }

  const pollStartedAt = new Date().toISOString();
  let issues: GitHubIssue[];

  try {
    issues = mergeIssues(
      await Promise.all([
        github.listOpenIssuesByLabel("needs-plan"),
        github.listOpenIssuesByLabel("ready-for-dev"),
        github.listOpenIssuesByLabel("in-qa"),
        github.listOpenIssuesByLabel("qa-passed"),
      ]),
    );
  } catch (err) {
    logger.error({ err }, "github list failed");

    return;
  }

  const work: Array<{ issue: GitHubIssue; role: Role }> = [];

  for (const issue of issues) {
    const role = roleForLabels(issue.labels, issue.body);

    if (!role) {
      const parent = parseRelatedParentIssue(issue.body);

      jobLog(
        logger,
        { issue: issue.number, role: null, agentId: null, runId: null },
        parent && issue.labels.includes("qa-passed")
          ? `skip RM: child bug Related to #${parent}`
          : issue.labels.includes("qa-passed")
            ? "skip RM: qa-passed is issue-QA, not a calendar release"
            : "skip: labels do not match a pipeline role trigger",
      );
      continue;
    }

    work.push({ issue, role });
  }

  const analystIssues = work.filter((item) => item.role === "analyst").map((item) => item.issue);

  for (const batch of groupAnalystIssuesByParent(analystIssues)) {
    if (batch.length > 1) {
      jobLog(
        logger,
        {
          issue: batch[0]?.number ?? null,
          role: "analyst",
          agentId: null,
          runId: null,
        },
        `parallel analyst dispatch: ${batch.map((issue) => `#${issue.number}`).join(", ")}`,
      );
    }
  }

  for (const { issue, role } of work) {
    if (inFlight.has(inFlightKey(issue.number, role))) {
      jobLog(
        logger,
        { issue: issue.number, role, agentId: null, runId: null },
        "skip in-flight job",
      );
    }
  }

  const toLaunch = selectJobsToLaunch(work, inFlight);
  const launchedByRole = new Map<Role, number[]>();

  for (const { issue, role } of toLaunch) {
    const numbers = launchedByRole.get(role) ?? [];

    numbers.push(issue.number);
    launchedByRole.set(role, numbers);
  }

  for (const [role, numbers] of launchedByRole) {
    jobLog(
      logger,
      {
        issue: numbers[0] ?? null,
        role,
        agentId: null,
        runId: null,
      },
      `${role} dispatch (parallel): ${numbers.map((number) => `#${number}`).join(", ")}`,
    );
  }

  for (const { issue, role } of toLaunch) {
    const key = inFlightKey(issue.number, role);

    inFlight.add(key);
    void handleIssue(config, logger, store, github, issue, role)
      .catch((err) => {
        logger.error({ err, issue: issue.number, role }, "pipeline job failed");
      })
      .finally(() => {
        inFlight.delete(key);
      });
  }

  await closeMergedChildBugs(github, logger, issues);
  await store.setLastPollAt(pollStartedAt);
}

async function applyAnalystLabels(
  github: GitHubClient,
  issue: number,
  decision: "ready-for-dev" | "needs-human",
): Promise<void> {
  await github.removeIssueLabel(issue, "in-analysis");
  await github.removeIssueLabel(issue, "needs-plan");
  await github.addIssueLabels(issue, [decision]);
}

async function applyDeveloperLabels(
  github: GitHubClient,
  issue: number,
  decision: "in-qa" | "needs-human",
): Promise<void> {
  await github.removeIssueLabel(issue, "in-dev");
  await github.removeIssueLabel(issue, "ready-for-dev");
  await github.addIssueLabels(issue, [decision]);
}

async function applyTesterLabels(
  github: GitHubClient,
  issue: number,
  decision: "in-qa" | "qa-passed" | "needs-human",
): Promise<void> {
  await github.removeIssueLabel(issue, "in-qa");
  await github.removeIssueLabel(issue, "qa-in-progress");
  await github.addIssueLabels(issue, [decision]);
}

async function labelTesterBugs(
  github: GitHubClient,
  store: JobStore,
  parent: GitHubIssue,
  bugIssues: number[],
): Promise<number[]> {
  const children = bugIssues.filter((number) => number !== parent.number);

  if (children.length !== bugIssues.length) {
    throw new Error("tester marked the parent issue as a child bug");
  }

  for (const issue of children) {
    // Новый круг плана: сбросить джобы и state-метки, только bug + needs-plan.
    await store.removeRoles(issue, ["analyst", "developer", "tester", "release-manager"]);
    await github.removeIssueLabel(issue, "in-analysis");
    await github.removeIssueLabel(issue, "ready-for-dev");
    await github.removeIssueLabel(issue, "in-dev");
    await github.removeIssueLabel(issue, "in-qa");
    await github.removeIssueLabel(issue, "qa-in-progress");
    await github.removeIssueLabel(issue, "qa-passed");
    await github.addIssueLabels(issue, ["bug", "needs-plan"]);

    if (parent.milestone) {
      try {
        await github.setIssueMilestone(issue, parent.milestone.number);
      } catch {
        // Milestone on child is best-effort; labels still stand.
      }
    }
  }

  const merged = [...new Set([...parseChildBugIssues(parent.body), ...children])];

  await github.updateIssueBody(
    parent.number,
    upsertChildBugIssuesInBody(parent.body, merged),
  );

  return children;
}

async function childBugsBlockingReQa(
  github: GitHubClient,
  parentBody: string | null,
): Promise<number[]> {
  const children = parseChildBugIssues(parentBody);
  const blocking: number[] = [];

  for (const number of children) {
    const child = await github.getIssue(number);
    const hasOpenFixPr = await github.hasOpenFixPr(number);

    if (childBlocksParentReQa(child.labels, child.state, hasOpenFixPr)) {
      blocking.push(number);
    }
  }

  return blocking;
}

async function closeMergedChildBugs(
  github: GitHubClient,
  logger: FastifyBaseLogger,
  issues: GitHubIssue[],
): Promise<void> {
  for (const issue of issues) {
    if (!issue.labels.includes("qa-passed")) {
      continue;
    }

    try {
      const hasOpenFixPr = await github.hasOpenFixPr(issue.number);
      const merged = hasOpenFixPr ? null : await github.findMergedFixPr(issue.number);

      if (
        !shouldCloseMergedChildIssue({
          body: issue.body,
          labels: issue.labels,
          hasOpenFixPr,
          hasMergedFixPr: merged !== null,
        })
      ) {
        continue;
      }

      await github.commentOnIssue(
        issue.number,
        `Пайплайн: фикс смержен в ${merged!.html_url} (не в default branch — GitHub issue сам не закрывает). Закрываю дочерний баг.`,
      );
      await github.closeIssue(issue.number);
      jobLog(
        logger,
        { issue: issue.number, role: null, agentId: null, runId: null },
        `closed child bug after merged PR #${merged!.number}`,
      );
    } catch (err) {
      logger.error({ err, issue: issue.number }, "close merged child bug failed");
    }
  }
}

async function retargetChildPullIfNeeded(
  github: GitHubClient,
  logger: FastifyBaseLogger,
  issue: GitHubIssue,
): Promise<void> {
  const parent = parseRelatedParentIssue(issue.body);

  if (!parent) {
    return;
  }

  try {
    const parentPr = await github.findOpenFixPr(parent);
    const childPr = await github.findOpenFixPr(issue.number);

    if (!parentPr || !childPr || !parentPr.headRef) {
      return;
    }

    if (childPr.baseRef === parentPr.headRef) {
      return;
    }

    await github.retargetPullBase(childPr.number, parentPr.headRef);
    await github.commentOnIssue(
      issue.number,
      `Пайплайн: base PR #${childPr.number} сменён на \`${parentPr.headRef}\` (ветка родителя #${parent}), не main.`,
    );
    jobLog(
      logger,
      { issue: issue.number, role: "developer", agentId: null, runId: null },
      `retargeted PR #${childPr.number} base ${childPr.baseRef} → ${parentPr.headRef}`,
    );
  } catch (err) {
    logger.error({ err, issue: issue.number }, "retarget child PR base failed");
  }
}

async function applyPublishedRelease(
  github: GitHubClient,
  issue: GitHubIssue,
  tag: string,
  changelog: string,
): Promise<string> {
  const release = await github.createPublishedRelease({
    tag,
    name: tag,
    body: changelog,
  });

  if (issue.milestone) {
    await github.closeMilestone(issue.milestone.number);
  }

  await github.commentOnIssue(
    issue.number,
    `Пайплайн: published Release ${tag}: ${release.html_url}`,
  );
  await github.closeIssue(issue.number);

  return release.html_url;
}

async function releaseStartGate(
  config: { SCHEDULE_TZ: string; CURSOR_STARTING_REF: string },
  github: GitHubClient,
  issue: GitHubIssue,
): Promise<{ ok: boolean; reason: string; previousTag: string | null }> {
  const milestone = issue.milestone;
  const tag = milestone ? tagFromMilestoneTitle(milestone.title) : null;
  let dueTodayCount = 0;
  let hasOpenWorkItems = false;
  let releaseExists = false;
  let nothingToRelease = false;
  let previousTag: string | null = null;

  try {
    const open = await github.listOpenMilestones();

    dueTodayCount = open.filter(
      (item) =>
        Boolean(tagFromMilestoneTitle(item.title)) &&
        daysUntilDue(item.due_on, config.SCHEDULE_TZ) === 0,
    ).length;
  } catch {
    dueTodayCount = 1;
  }

  if (milestone) {
    try {
      const issues = await github.listOpenIssuesForMilestone(milestone.number);

      hasOpenWorkItems = issues.some(
        (item) => item.number !== issue.number && isReleaseWorkIssue(item.labels),
      );
    } catch {
      hasOpenWorkItems = true;
    }
  }

  if (tag) {
    try {
      releaseExists = await github.tagOrReleaseExists(tag);
    } catch {
      releaseExists = false;
    }

    if (!releaseExists) {
      try {
        const detected = await github.detectEmptySincePrevious(tag, config.CURSOR_STARTING_REF);

        nothingToRelease = detected.empty;
        previousTag = detected.previousTag;
      } catch {
        nothingToRelease = false;
      }
    }
  }

  const gate = decideReleaseGate({
    labels: issue.labels,
    body: issue.body,
    milestoneTitle: milestone?.title ?? null,
    dueOn: milestone?.due_on ?? null,
    timeZone: config.SCHEDULE_TZ,
    dueTodayCount,
    hasOpenWorkItems,
    releaseExists,
    nothingToRelease,
  });

  return { ok: gate === "ok", reason: gate, previousTag };
}

async function handleIssue(
  config: Config,
  logger: FastifyBaseLogger,
  store: JobStore,
  github: GitHubClient,
  issue: GitHubIssue,
  role: Role,
): Promise<void> {
  const fields = { issue: issue.number, role, agentId: null, runId: null };

  if (role === "developer") {
    if (fixRoundBlocksDeveloper(issue.body)) {
      try {
        await applyDeveloperLabels(github, issue.number, "needs-human");
        await github.commentOnIssue(
          issue.number,
          `Пайплайн: лимит \`fix-round\` (${MAX_FIX_ROUNDS}) исчерпан — разработчик не стартует, нужен человек.`,
        );
        jobLog(logger, fields, "labels: fix-round limit → needs-human");
      } catch (err) {
        logger.error({ err, issue: issue.number }, "fix-round limit labels failed");
      }

      return;
    }

    let hasPr = false;

    try {
      hasPr = await github.hasOpenFixPr(issue.number);
    } catch (err) {
      logger.error({ err, issue: issue.number }, "github pulls failed");

      return;
    }

    if (hasPr) {
      try {
        await applyDeveloperLabels(github, issue.number, "in-qa");
        jobLog(logger, fields, "labels: PR already open → in-qa");
      } catch (err) {
        logger.error({ err, issue: issue.number }, "github labels failed");
      }

      await retargetChildPullIfNeeded(github, logger, issue);

      return;
    }
  }

  let linkedPull: GitHubPull | undefined;
  const regression = isRegressionIssue(issue.labels, issue.body);

  if ((role === "tester" || role === "release-manager") && !regression) {
    try {
      linkedPull = (await github.findOpenFixPr(issue.number)) ?? undefined;
    } catch (err) {
      logger.error({ err, issue: issue.number }, "github pulls failed");

      return;
    }

    if (role === "tester" && !linkedPull) {
      try {
        await applyTesterLabels(github, issue.number, "needs-human");
        await github.commentOnIssue(
          issue.number,
          "Пайплайн: `in-qa`, но нет открытого PR с `Fixes #<этот номер>` — тестировщик не стартует, нужен человек. Допишите `Fixes #N` в тело PR (не затирая старые Fixes) или снимите `in-qa`.",
        );
        jobLog(logger, fields, "labels: no Fixes PR → needs-human");
      } catch (err) {
        logger.error({ err, issue: issue.number }, "tester missing PR labels failed");
      }

      return;
    }
  }

  if (role === "release-manager") {
    const gate = await releaseStartGate(config, github, issue);

    if (!gate.ok) {
      if (gate.reason === "nothing-to-release" && issue.milestone && gate.previousTag) {
        try {
          await closeEmptyRelease(github, logger, issue.milestone, gate.previousTag);
        } catch (err) {
          logger.error({ err, issue: issue.number }, "close empty milestone failed");
        }
      }

      jobLog(logger, fields, `skip RM: ${gate.reason}`);

      return;
    }
  }

  if (role === "analyst") {
    const parent = parseRelatedParentIssue(issue.body);

    if (parent) {
      try {
        linkedPull = (await github.findOpenFixPr(parent)) ?? undefined;
      } catch (err) {
        logger.error({ err, issue: issue.number, parent }, "github parent PR lookup failed");
      }
    }
  }

  if (role === "developer") {
    const parent = parseRelatedParentIssue(issue.body);

    if (parent) {
      try {
        linkedPull = (await github.findOpenFixPr(parent)) ?? undefined;

        if (linkedPull) {
          jobLog(logger, fields, `child developer startingRef: ${linkedPull.headRef} (parent #${parent})`);
        }
      } catch (err) {
        logger.error({ err, issue: issue.number, parent }, "github parent PR lookup failed");
      }
    }
  }

  if (role === "tester") {
    try {
      const blocking = await childBugsBlockingReQa(github, issue.body);

      if (blocking.length > 0) {
        jobLog(
          logger,
          fields,
          `skip tester: waiting for child bugs ${blocking.map((n) => `#${n}`).join(", ")}`,
        );

        return;
      }

      if (parseChildBugIssues(issue.body).length > 0 && (await store.find(issue.number, "tester"))) {
        await store.remove(issue.number, "tester");
        jobLog(logger, fields, "cleared tester job for re-QA after child bugs");
      }
    } catch (err) {
      logger.error({ err, issue: issue.number }, "child bug status check failed");

      return;
    }
  }

  if (await store.find(issue.number, role)) {
    jobLog(logger, fields, "skip existing job");

    return;
  }

  if (!config.CURSOR_API_KEY || !config.CURSOR_REPO_URL) {
    jobLog(logger, fields, "poll skip: CURSOR_API_KEY or CURSOR_REPO_URL empty");

    return;
  }

  const job = await store.create(issue.number, role);

  if (!job) {
    jobLog(logger, fields, "skip existing job");

    return;
  }

  await store.update(job.id, { status: "running" });

  if (role === "analyst") {
    try {
      await github.removeIssueLabel(issue.number, "needs-plan");
      await github.addIssueLabels(issue.number, ["in-analysis"]);
      jobLog(logger, fields, "labels: -needs-plan +in-analysis");
    } catch (err) {
      await store.update(job.id, {
        status: "startup_error",
        error: "failed to set in-analysis",
      });
      logger.error({ err, issue: issue.number }, "github analyst labels failed");
      try {
        await applyAnalystLabels(github, issue.number, "needs-human");
      } catch (labelErr) {
        logger.error({ err: labelErr, issue: issue.number }, "github fallback labels failed");
      }

      return;
    }
  }

  if (role === "developer") {
    const nextRound = (parseFixRound(issue.body) ?? 0) + 1;

    try {
      const body = upsertFixRoundInBody(issue.body, nextRound);

      await github.updateIssueBody(issue.number, body);
      issue = { ...issue, body };
      jobLog(logger, fields, `fix-round: ${nextRound}`);
    } catch (err) {
      await store.update(job.id, { status: "startup_error", error: "failed to set fix-round" });
      logger.error({ err, issue: issue.number }, "fix-round update failed");
      try {
        await applyDeveloperLabels(github, issue.number, "needs-human");
      } catch (labelErr) {
        logger.error({ err: labelErr, issue: issue.number }, "github fallback labels failed");
      }

      return;
    }

    try {
      await github.removeIssueLabel(issue.number, "ready-for-dev");
      await github.addIssueLabels(issue.number, ["in-dev"]);
      jobLog(logger, fields, "labels: -ready-for-dev +in-dev");
    } catch (err) {
      await store.update(job.id, {
        status: "startup_error",
        error: "failed to set in-dev",
      });
      logger.error({ err, issue: issue.number }, "github developer labels failed");
      try {
        await applyDeveloperLabels(github, issue.number, "needs-human");
      } catch (labelErr) {
        logger.error({ err: labelErr, issue: issue.number }, "github fallback labels failed");
      }

      return;
    }
  }

  if (role === "tester") {
    try {
      await github.removeIssueLabel(issue.number, "in-qa");
      await github.addIssueLabels(issue.number, ["qa-in-progress"]);
      jobLog(logger, fields, "labels: -in-qa +qa-in-progress");
    } catch (err) {
      await store.update(job.id, {
        status: "startup_error",
        error: "failed to set qa-in-progress",
      });
      logger.error({ err, issue: issue.number }, "github QA labels failed");
      try {
        await applyTesterLabels(github, issue.number, "needs-human");
      } catch (labelErr) {
        logger.error({ err: labelErr, issue: issue.number }, "github fallback labels failed");
      }

      return;
    }
  }

  jobLog(logger, { ...fields }, "cursor agent starting");

  const result = await runCloudAgent(
    config,
    role,
    issue,
    async ({ agentId, runId }) => {
      await store.update(job.id, { agentId, runId });
      jobLog(logger, { issue: issue.number, role, agentId, runId }, "cursor run started");
      try {
        await github.commentOnIssue(
          issue.number,
          jobComment({
            jobId: job.id,
            role,
            agentId,
            runId,
            status: "running",
          }),
        );
      } catch (err) {
        logger.error({ err, issue: issue.number }, "github comment failed");
      }
    },
    linkedPull,
  );

  const status = result.status === "finished" ? "finished" : result.status;

  await store.update(job.id, {
    status,
    agentId: result.agentId,
    runId: result.runId,
    error: result.error,
  });
  jobLog(
    logger,
    {
      issue: issue.number,
      role,
      agentId: result.agentId,
      runId: result.runId,
    },
    result.status === "finished" ? "cursor run finished" : "cursor run failed",
  );

  let decision: string | null = null;

  if (role === "analyst") {
    const analystDecision = decideAnalystOutcome(result.status, result.text);

    decision = analystDecision;
    try {
      await applyAnalystLabels(github, issue.number, analystDecision);
      jobLog(
        logger,
        {
          issue: issue.number,
          role,
          agentId: result.agentId,
          runId: result.runId,
        },
        `labels: -in-analysis +${decision}`,
      );
    } catch (err) {
      logger.error({ err, issue: issue.number }, "github labels failed");
    }
  }

  if (role === "developer") {
    let hasPr = false;

    try {
      hasPr = await github.hasOpenFixPr(issue.number);
    } catch (err) {
      logger.error({ err, issue: issue.number }, "github pulls failed");
    }

    const developerDecision = decideDeveloperOutcome(result.status, hasPr);

    decision = developerDecision;
    try {
      await applyDeveloperLabels(github, issue.number, developerDecision);
      jobLog(
        logger,
        {
          issue: issue.number,
          role,
          agentId: result.agentId,
          runId: result.runId,
        },
        `labels: -in-dev +${decision}`,
      );
    } catch (err) {
      logger.error({ err, issue: issue.number }, "github labels failed");
    }

    if (developerDecision === "in-qa") {
      await retargetChildPullIfNeeded(github, logger, issue);
    }
  }

  if (role === "tester") {
    const bugIssues = extractTesterBugIssues(result.text);
    let testerDecision = decideTesterOutcome(
      result.status,
      result.text,
      bugIssues,
    );

    if (testerDecision === "in-qa") {
      const handoff = classifyTesterBugHandoff(issue.body, bugIssues ?? []);

      if (handoff !== "ok") {
        testerDecision = "needs-human";
        const reason =
          handoff === "grandchild"
            ? "Пайплайн: тестировщик на дочернем баге (`Related to #`) открыл новые issues — глубина дерева QA = 1, внуки запрещены. Нужен человек."
            : `Пайплайн: тестировщик создал больше ${MAX_TESTER_CHILD_BUGS} bug-issues за прогон (лимит). Нужен человек.`;

        try {
          await github.commentOnIssue(issue.number, reason);
        } catch (err) {
          logger.error({ err, issue: issue.number }, "tester handoff comment failed");
        }

        jobLog(
          logger,
          {
            issue: issue.number,
            role,
            agentId: result.agentId,
            runId: result.runId,
          },
          `tester bug handoff rejected: ${handoff}`,
        );
      } else {
        try {
          const bugs = await labelTesterBugs(github, store, issue, bugIssues ?? []);

          jobLog(
            logger,
            {
              issue: issue.number,
              role,
              agentId: result.agentId,
              runId: result.runId,
            },
            bugs.length
              ? `labeled tester bugs: ${bugs.map((number) => `#${number}`).join(", ")}`
              : "tester reported no bugs",
          );
        } catch (err) {
          testerDecision = "needs-human";
          logger.error({ err, issue: issue.number }, "tester bug handoff failed");
        }
      }
    }

    decision = testerDecision;
    try {
      await applyTesterLabels(github, issue.number, testerDecision);
      jobLog(
        logger,
        {
          issue: issue.number,
          role,
          agentId: result.agentId,
          runId: result.runId,
        },
        `labels: -qa-in-progress +${testerDecision}`,
      );
    } catch (err) {
      logger.error({ err, issue: issue.number }, "github labels failed");
    }
  }

  if (role === "release-manager") {
    const tag = extractReleaseTag(result.text);
    const changelog = extractReleaseChangelog(result.text);
    const expectedTag = issue.milestone ? tagFromMilestoneTitle(issue.milestone.title) : null;
    let releaseDecision = decideReleaseManagerOutcome(
      result.status,
      result.text,
      tag,
      changelog,
      expectedTag,
    );

    if (releaseDecision === "released" && tag && changelog) {
      try {
        const releaseUrl = await applyPublishedRelease(github, issue, tag, changelog);

        jobLog(
          logger,
          {
            issue: issue.number,
            role,
            agentId: result.agentId,
            runId: result.runId,
          },
          `published release ${tag}: ${releaseUrl}`,
        );
      } catch (err) {
        releaseDecision = "needs-human";
        logger.error({ err, issue: issue.number }, "release package failed");
      }
    }

    decision = releaseDecision;

    if (releaseDecision === "needs-human") {
      try {
        await github.addIssueLabels(issue.number, ["needs-human"]);
        jobLog(
          logger,
          {
            issue: issue.number,
            role,
            agentId: result.agentId,
            runId: result.runId,
          },
          "labels: +needs-human",
        );
      } catch (err) {
        logger.error({ err, issue: issue.number }, "github labels failed");
      }
    }
  }

  if (decision) {
    await store.update(job.id, { decision });
  }

  try {
    await github.commentOnIssue(
      issue.number,
      jobComment({
        jobId: job.id,
        role,
        agentId: result.agentId,
        runId: result.runId,
        status: result.status,
        error: result.error,
        decision,
      }),
    );
  } catch (err) {
    logger.error({ err, issue: issue.number }, "github comment failed");
  }

  if (result.text?.trim()) {
    try {
      await github.commentOnIssue(issue.number, agentResultComment(role, result.text));
    } catch (err) {
      logger.error({ err, issue: issue.number }, "github plan comment failed");
    }
  }
}
