import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '@config';
import {
  CursorClient,
  generateAgentResultComment,
  generateJobComment,
  GitHubClient,
  type GitHubIssue,
  type GitHubIssueComment,
  type GitHubPull,
  LogClient,
} from '@providers';
import type { Role } from '@types';

import { inFlightKey, selectJobsToLaunch } from './dispatch';
import { JobStore } from './jobs';
import {
  analystKind,
  childBlocksParentReQa,
  classifyTesterBugHandoff,
  decideAnalystOutcome,
  decideDeveloperOutcome,
  decideReleaseManagerOutcome,
  decideTesterOutcome,
  extractMvpTaskIssues,
  extractReleaseChangelog,
  extractReleaseTag,
  extractTesterBugIssues,
  fixRoundBlocksDeveloper,
  groupAnalystIssuesByParent,
  isQaRole,
  MAX_FIX_ROUNDS,
  MAX_TESTER_CHILD_BUGS,
  parseChildBugIssues,
  parseFixRound,
  parseMvpTaskIssues,
  parseRelatedParentIssue,
  roleForLabels,
  shouldCloseMergedChildIssue,
  shouldResetMvpAnalystJob,
  upsertChildBugIssuesInBody,
  upsertFixRoundInBody,
  upsertMvpTaskIssuesInBody,
} from './rules';
import { closeEmptyRelease } from './schedule';
import {
  daysUntilDue,
  decideReleaseGate,
  isReleaseWorkIssue,
  tagFromMilestoneTitle,
} from './schedule-rules';

export function startPoller(
  config: Config,
  appLogger: FastifyBaseLogger,
  store: JobStore,
): { stop: () => void } {
  const github = new GitHubClient(config);
  const cursor = new CursorClient(config);
  const logger = new LogClient(appLogger);
  let listing = false;
  const inFlight = new Set<string>();

  const tick = (): void => {
    if (listing) {
      logger.job({}, 'poll skip: previous tick still running');

      return;
    }

    listing = true;
    void pollOnce(config, logger, store, github, cursor, inFlight).finally(
      () => {
        listing = false;
      },
    );
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
  logger: LogClient,
  store: JobStore,
  github: GitHubClient,
  cursor: CursorClient,
  inFlight: Set<string>,
): Promise<void> {
  logger.job({}, 'poll tick');

  if (!config.GITHUB_TOKEN || !config.GITHUB_REPO) {
    logger.job({}, 'poll skip: GITHUB_TOKEN or GITHUB_REPO empty');

    return;
  }

  const pollStartedAt = new Date().toISOString();
  let issues: GitHubIssue[];

  try {
    issues = mergeIssues(
      await Promise.all([
        github.getOpenIssuesByLabel('needs-plan'),
        github.getOpenIssuesByLabel('ready-for-dev'),
        github.getOpenIssuesByLabel('in-qa'),
        github.getOpenIssuesByLabel('qa-passed'),
        github.getOpenIssuesByLabel('approved'),
      ]),
    );
  } catch (err) {
    logger.error({ err }, 'github list failed');

    return;
  }

  const work: Array<{ issue: GitHubIssue; role: Role }> = [];

  for (const issue of issues) {
    const role = roleForLabels(issue.labels, issue.body);

    if (!role) {
      const parent = parseRelatedParentIssue(issue.body);

      logger.job(
        { issue: issue.number, role: null, agentId: null, runId: null },
        parent && issue.labels.includes('qa-passed')
          ? `skip RM: child bug Related to #${parent}`
          : issue.labels.includes('qa-passed')
            ? 'skip RM: qa-passed is issue-QA, not a calendar release'
            : 'skip: labels do not match a pipeline role trigger',
      );
      continue;
    }

    work.push({ issue, role });
  }

  const analystIssues = work
    .filter((item) => item.role === 'analyst')
    .map((item) => item.issue);

  for (const batch of groupAnalystIssuesByParent(analystIssues)) {
    if (batch.length > 1) {
      logger.job(
        {
          issue: batch[0]?.number ?? null,
          role: 'analyst',
          agentId: null,
          runId: null,
        },
        `parallel analyst dispatch: ${batch
          .map((issue) => `#${issue.number}`)
          .join(', ')}`,
      );
    }
  }

  for (const { issue, role } of work) {
    if (inFlight.has(inFlightKey(issue.number, role))) {
      logger.job(
        { issue: issue.number, role, agentId: null, runId: null },
        'skip in-flight job',
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
    logger.job(
      {
        issue: numbers[0] ?? null,
        role,
        agentId: null,
        runId: null,
      },
      `${role} dispatch (parallel): ${numbers
        .map((number) => `#${number}`)
        .join(', ')}`,
    );
  }

  for (const { issue, role } of toLaunch) {
    const key = inFlightKey(issue.number, role);

    inFlight.add(key);
    void handleIssue(config, logger, store, github, cursor, issue, role)
      .catch((err) => {
        logger.error({ err, issue: issue.number, role }, 'pipeline job failed');
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
  decision: 'ready-for-dev' | 'needs-human' | 'to-approve' | 'done',
): Promise<void> {
  await github.removeIssueLabel(issue, 'in-analysis');
  await github.removeIssueLabel(issue, 'needs-plan');
  await github.removeIssueLabel(issue, 'to-approve');
  await github.removeIssueLabel(issue, 'approved');

  if (decision === 'done') {
    return;
  }

  await github.addIssueLabels(issue, [decision]);
}

async function applyDeveloperLabels(
  github: GitHubClient,
  issue: number,
  decision: 'in-qa' | 'needs-human',
): Promise<void> {
  await github.removeIssueLabel(issue, 'in-dev');
  await github.removeIssueLabel(issue, 'ready-for-dev');
  await github.addIssueLabels(issue, [decision]);
}

async function applyTesterLabels(
  github: GitHubClient,
  issue: number,
  decision: 'in-qa' | 'qa-passed' | 'needs-human',
): Promise<void> {
  await github.removeIssueLabel(issue, 'in-qa');
  await github.removeIssueLabel(issue, 'qa-in-progress');
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
    throw new Error('tester marked the parent issue as a child bug');
  }

  for (const issue of children) {
    // Новый круг плана: сбросить джобы и state-метки, только bug + needs-plan.
    await store.removeRoles(issue, [
      'analyst',
      'developer',
      'tester',
      'tester-regression',
      'release-manager',
    ]);
    await github.removeIssueLabel(issue, 'in-analysis');
    await github.removeIssueLabel(issue, 'ready-for-dev');
    await github.removeIssueLabel(issue, 'in-dev');
    await github.removeIssueLabel(issue, 'in-qa');
    await github.removeIssueLabel(issue, 'qa-in-progress');
    await github.removeIssueLabel(issue, 'qa-passed');
    await github.removeIssueLabel(issue, 'to-approve');
    await github.removeIssueLabel(issue, 'approved');
    await github.addIssueLabels(issue, ['bug', 'needs-plan']);

    if (parent.milestone) {
      try {
        await github.setIssueMilestone(issue, parent.milestone.number);
      } catch {
        // Milestone on child is best-effort; labels still stand.
      }
    }
  }

  const merged = [
    ...new Set([...parseChildBugIssues(parent.body), ...children]),
  ];

  await github.updateIssueBody(
    parent.number,
    upsertChildBugIssuesInBody(parent.body, merged),
  );

  return children;
}

async function labelMvpTasks(
  github: GitHubClient,
  store: JobStore,
  parent: GitHubIssue,
  taskIssues: number[],
): Promise<number[]> {
  const children = taskIssues.filter((number) => number !== parent.number);

  if (children.length !== taskIssues.length) {
    throw new Error('analyst marked the mvp issue as a spawned task');
  }

  if (children.length === 0) {
    throw new Error('mvp spawn reported no tasks');
  }

  for (const number of children) {
    const child = await github.getIssue(number);

    if (child.state === 'closed') {
      throw new Error(`mvp spawned task #${number} is closed`);
    }

    await store.removeRoles(number, [
      'analyst',
      'developer',
      'tester',
      'tester-regression',
      'release-manager',
    ]);
    await github.removeIssueLabel(number, 'in-analysis');
    await github.removeIssueLabel(number, 'ready-for-dev');
    await github.removeIssueLabel(number, 'in-dev');
    await github.removeIssueLabel(number, 'in-qa');
    await github.removeIssueLabel(number, 'qa-in-progress');
    await github.removeIssueLabel(number, 'qa-passed');
    await github.removeIssueLabel(number, 'to-approve');
    await github.removeIssueLabel(number, 'approved');
    await github.removeIssueLabel(number, 'needs-human');
    await github.removeIssueLabel(number, 'mvp');
    await github.removeIssueLabel(number, 'regression');

    const typeLabel = child.labels.includes('bug') ? 'bug' : 'feature';

    await github.addIssueLabels(number, [typeLabel, 'needs-plan']);

    if (parent.milestone) {
      try {
        await github.setIssueMilestone(number, parent.milestone.number);
      } catch {
        // Milestone on spawned task is best-effort; labels still stand.
      }
    }
  }

  const merged = [
    ...new Set([...parseMvpTaskIssues(parent.body), ...children]),
  ];

  await github.updateIssueBody(
    parent.number,
    upsertMvpTaskIssuesInBody(parent.body, merged),
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
  logger: LogClient,
  issues: GitHubIssue[],
): Promise<void> {
  for (const issue of issues) {
    if (!issue.labels.includes('qa-passed')) {
      continue;
    }

    try {
      const hasOpenFixPr = await github.hasOpenFixPr(issue.number);
      const merged = hasOpenFixPr
        ? null
        : await github.findMergedFixPr(issue.number);

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
        `Пайплайн: фикс смержен в ${merged!.html_url} ` +
          '(не в default branch — GitHub issue сам не закрывает). ' +
          'Закрываю дочерний баг.',
      );
      await github.closeIssue(issue.number);
      logger.job(
        { issue: issue.number, role: null, agentId: null, runId: null },
        `closed child bug after merged PR #${merged!.number}`,
      );
    } catch (err) {
      logger.error(
        { err, issue: issue.number },
        'close merged child bug failed',
      );
    }
  }
}

async function retargetChildPullIfNeeded(
  github: GitHubClient,
  logger: LogClient,
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
      `Пайплайн: base PR #${childPr.number} сменён на ` +
        `\`${parentPr.headRef}\` (ветка родителя #${parent}), не main.`,
    );
    logger.job(
      { issue: issue.number, role: 'developer', agentId: null, runId: null },
      `retargeted PR #${childPr.number} base ` +
        `${childPr.baseRef} → ${parentPr.headRef}`,
    );
  } catch (err) {
    logger.error({ err, issue: issue.number }, 'retarget child PR base failed');
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
    const open = await github.getOpenMilestones();

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
      const issues = await github.getOpenIssuesForMilestone(milestone.number);

      hasOpenWorkItems = issues.some(
        (item) =>
          item.number !== issue.number && isReleaseWorkIssue(item.labels),
      );
    } catch {
      hasOpenWorkItems = true;
    }
  }

  if (tag) {
    try {
      releaseExists = await github.isTagOrReleaseExists(tag);
    } catch {
      releaseExists = false;
    }

    if (!releaseExists) {
      try {
        const detected = await github.detectEmptySincePrevious(
          tag,
          config.CURSOR_STARTING_REF,
        );

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

  return { ok: gate === 'ok', reason: gate, previousTag };
}

async function handleIssue(
  config: Config,
  logger: LogClient,
  store: JobStore,
  github: GitHubClient,
  cursor: CursorClient,
  issue: GitHubIssue,
  role: Role,
): Promise<void> {
  const fields = { issue: issue.number, role, agentId: null, runId: null };

  if (role === 'developer') {
    if (fixRoundBlocksDeveloper(issue.body)) {
      try {
        await applyDeveloperLabels(github, issue.number, 'needs-human');
        await github.commentOnIssue(
          issue.number,
          `Пайплайн: лимит \`fix-round\` (${MAX_FIX_ROUNDS}) исчерпан — ` +
            'разработчик не стартует, нужен человек.',
        );
        logger.job(fields, 'labels: fix-round limit → needs-human');
      } catch (err) {
        logger.error(
          { err, issue: issue.number },
          'fix-round limit labels failed',
        );
      }

      return;
    }

    let hasPr = false;

    try {
      hasPr = await github.hasOpenFixPr(issue.number);
    } catch (err) {
      logger.error({ err, issue: issue.number }, 'github pulls failed');

      return;
    }

    if (hasPr) {
      try {
        await applyDeveloperLabels(github, issue.number, 'in-qa');
        logger.job(fields, 'labels: PR already open → in-qa');
      } catch (err) {
        logger.error({ err, issue: issue.number }, 'github labels failed');
      }

      await retargetChildPullIfNeeded(github, logger, issue);

      return;
    }
  }

  let linkedPull: GitHubPull | undefined;

  if (role === 'tester') {
    try {
      linkedPull = (await github.findOpenFixPr(issue.number)) ?? undefined;
    } catch (err) {
      logger.error({ err, issue: issue.number }, 'github pulls failed');

      return;
    }

    if (!linkedPull) {
      try {
        await applyTesterLabels(github, issue.number, 'needs-human');
        await github.commentOnIssue(
          issue.number,
          'Пайплайн: `in-qa`, но нет открытого PR с ' +
            '`Fixes #<этот номер>` — тестировщик не стартует, нужен человек. ' +
            'Допишите `Fixes #N` в тело PR (не затирая старые Fixes) ' +
            'или снимите `in-qa`.',
        );
        logger.job(fields, 'labels: no Fixes PR → needs-human');
      } catch (err) {
        logger.error(
          { err, issue: issue.number },
          'tester missing PR labels failed',
        );
      }

      return;
    }
  }

  if (role === 'release-manager') {
    const gate = await releaseStartGate(config, github, issue);

    if (!gate.ok) {
      if (
        gate.reason === 'nothing-to-release' &&
        issue.milestone &&
        gate.previousTag
      ) {
        try {
          await closeEmptyRelease(
            github,
            logger,
            issue.milestone,
            gate.previousTag,
          );
        } catch (err) {
          logger.error(
            { err, issue: issue.number },
            'close empty milestone failed',
          );
        }
      }

      logger.job(fields, `skip RM: ${gate.reason}`);

      return;
    }
  }

  if (role === 'analyst') {
    const parent = parseRelatedParentIssue(issue.body);

    if (parent) {
      try {
        linkedPull = (await github.findOpenFixPr(parent)) ?? undefined;
      } catch (err) {
        logger.error(
          { err, issue: issue.number, parent },
          'github parent PR lookup failed',
        );
      }
    }
  }

  if (role === 'developer') {
    const parent = parseRelatedParentIssue(issue.body);

    if (parent) {
      try {
        linkedPull = (await github.findOpenFixPr(parent)) ?? undefined;

        if (linkedPull) {
          logger.job(
            fields,
            `child developer startingRef: ${linkedPull.headRef} ` +
              `(parent #${parent})`,
          );
        }
      } catch (err) {
        logger.error(
          { err, issue: issue.number, parent },
          'github parent PR lookup failed',
        );
      }
    }
  }

  if (isQaRole(role)) {
    try {
      const blocking = await childBugsBlockingReQa(github, issue.body);

      if (blocking.length > 0) {
        logger.job(
          fields,
          `skip ${role}: waiting for child bugs ${blocking
            .map((n) => `#${n}`)
            .join(', ')}`,
        );

        return;
      }

      if (
        parseChildBugIssues(issue.body).length > 0 &&
        (await store.find(issue.number, role))
      ) {
        await store.remove(issue.number, role);
        logger.job(fields, `cleared ${role} job for re-QA after child bugs`);
      }
    } catch (err) {
      logger.error(
        { err, issue: issue.number },
        'child bug status check failed',
      );

      return;
    }
  }

  if (role === 'analyst') {
    try {
      const existing = await store.find(issue.number, 'analyst');

      if (
        shouldResetMvpAnalystJob({
          labels: issue.labels,
          jobStatus: existing?.status,
        })
      ) {
        await store.remove(issue.number, 'analyst');
        logger.job(fields, 'cleared analyst job for mvp re-plan or spawn');
      }
    } catch (err) {
      logger.error(
        { err, issue: issue.number },
        'mvp analyst job reset failed',
      );

      return;
    }
  }

  if (await store.find(issue.number, role)) {
    logger.job(fields, 'skip existing job');

    return;
  }

  if (!config.CURSOR_API_KEY || !config.CURSOR_REPO_URL) {
    logger.job(fields, 'poll skip: CURSOR_API_KEY or CURSOR_REPO_URL empty');

    return;
  }

  const job = await store.create(issue.number, role);

  if (!job) {
    logger.job(fields, 'skip existing job');

    return;
  }

  await store.update(job.id, { status: 'running' });

  if (role === 'analyst') {
    try {
      await github.removeIssueLabel(issue.number, 'needs-plan');
      await github.removeIssueLabel(issue.number, 'approved');
      await github.removeIssueLabel(issue.number, 'to-approve');
      await github.addIssueLabels(issue.number, ['in-analysis']);
      logger.job(
        fields,
        'labels: -needs-plan -approved -to-approve +in-analysis',
      );
    } catch (err) {
      await store.update(job.id, {
        status: 'startup_error',
        error: 'failed to set in-analysis',
      });
      logger.error(
        { err, issue: issue.number },
        'github analyst labels failed',
      );
      try {
        await applyAnalystLabels(github, issue.number, 'needs-human');
      } catch (labelErr) {
        logger.error(
          { err: labelErr, issue: issue.number },
          'github fallback labels failed',
        );
      }

      return;
    }
  }

  if (role === 'developer') {
    const nextRound = (parseFixRound(issue.body) ?? 0) + 1;

    try {
      const body = upsertFixRoundInBody(issue.body, nextRound);

      await github.updateIssueBody(issue.number, body);
      issue = { ...issue, body };
      logger.job(fields, `fix-round: ${nextRound}`);
    } catch (err) {
      await store.update(job.id, {
        status: 'startup_error',
        error: 'failed to set fix-round',
      });
      logger.error({ err, issue: issue.number }, 'fix-round update failed');
      try {
        await applyDeveloperLabels(github, issue.number, 'needs-human');
      } catch (labelErr) {
        logger.error(
          { err: labelErr, issue: issue.number },
          'github fallback labels failed',
        );
      }

      return;
    }

    try {
      await github.removeIssueLabel(issue.number, 'ready-for-dev');
      await github.addIssueLabels(issue.number, ['in-dev']);
      logger.job(fields, 'labels: -ready-for-dev +in-dev');
    } catch (err) {
      await store.update(job.id, {
        status: 'startup_error',
        error: 'failed to set in-dev',
      });
      logger.error(
        { err, issue: issue.number },
        'github developer labels failed',
      );
      try {
        await applyDeveloperLabels(github, issue.number, 'needs-human');
      } catch (labelErr) {
        logger.error(
          { err: labelErr, issue: issue.number },
          'github fallback labels failed',
        );
      }

      return;
    }
  }

  if (isQaRole(role)) {
    try {
      await github.removeIssueLabel(issue.number, 'in-qa');
      await github.addIssueLabels(issue.number, ['qa-in-progress']);
      logger.job(fields, 'labels: -in-qa +qa-in-progress');
    } catch (err) {
      await store.update(job.id, {
        status: 'startup_error',
        error: 'failed to set qa-in-progress',
      });
      logger.error({ err, issue: issue.number }, 'github QA labels failed');
      try {
        await applyTesterLabels(github, issue.number, 'needs-human');
      } catch (labelErr) {
        logger.error(
          { err: labelErr, issue: issue.number },
          'github fallback labels failed',
        );
      }

      return;
    }
  }

  logger.job({ ...fields }, 'cursor agent starting');

  let analystComments: GitHubIssueComment[] | undefined;

  if (role === 'analyst') {
    try {
      analystComments = await github.listIssueComments(issue.number);
    } catch (err) {
      logger.error(
        { err, issue: issue.number },
        'github analyst comments failed',
      );
    }
  }

  const result = await cursor.runCloudAgent(
    role,
    analystComments ? { ...issue, comments: analystComments } : issue,
    async ({ agentId, runId }) => {
      await store.update(job.id, { agentId, runId });
      logger.job(
        { issue: issue.number, role, agentId, runId },
        'cursor run started',
      );
      try {
        await github.commentOnIssue(
          issue.number,
          generateJobComment({
            jobId: job.id,
            role,
            agentId,
            runId,
            status: 'running',
          }),
        );
      } catch (err) {
        logger.error({ err, issue: issue.number }, 'github comment failed');
      }
    },
    linkedPull,
  );

  const status = result.status === 'finished' ? 'finished' : result.status;

  await store.update(job.id, {
    status,
    agentId: result.agentId,
    runId: result.runId,
    error: result.error,
  });
  logger.job(
    {
      issue: issue.number,
      role,
      agentId: result.agentId,
      runId: result.runId,
    },
    result.status === 'finished' ? 'cursor run finished' : 'cursor run failed',
  );

  let decision: string | null = null;

  if (role === 'analyst') {
    const kind = analystKind(issue.labels) ?? 'work';
    let analystDecision = decideAnalystOutcome(
      result.status,
      result.text,
      kind,
    );

    if (kind === 'mvp-spawn' && analystDecision === 'done') {
      try {
        const tasks = await labelMvpTasks(
          github,
          store,
          issue,
          extractMvpTaskIssues(result.text) ?? [],
        );

        logger.job(
          {
            issue: issue.number,
            role,
            agentId: result.agentId,
            runId: result.runId,
          },
          `labeled mvp tasks: ${tasks.map((n) => `#${n}`).join(', ')}`,
        );
        await github.commentOnIssue(
          issue.number,
          'Пайплайн: MVP закрыт, созданы задачи: ' +
            tasks.map((n) => `#${n}`).join(', ') +
            '.',
        );
        await applyAnalystLabels(github, issue.number, 'done');
        await github.closeIssue(issue.number);
      } catch (err) {
        analystDecision = 'needs-human';
        logger.error({ err, issue: issue.number }, 'mvp spawn handoff failed');
        try {
          await applyAnalystLabels(github, issue.number, 'needs-human');
        } catch (labelErr) {
          logger.error(
            { err: labelErr, issue: issue.number },
            'github labels failed',
          );
        }
      }
    } else {
      try {
        await applyAnalystLabels(github, issue.number, analystDecision);
        logger.job(
          {
            issue: issue.number,
            role,
            agentId: result.agentId,
            runId: result.runId,
          },
          `labels: -in-analysis +${analystDecision}`,
        );
      } catch (err) {
        logger.error({ err, issue: issue.number }, 'github labels failed');
      }
    }

    decision = analystDecision;
  }

  if (role === 'developer') {
    let hasPr = false;

    try {
      hasPr = await github.hasOpenFixPr(issue.number);
    } catch (err) {
      logger.error({ err, issue: issue.number }, 'github pulls failed');
    }

    const developerDecision = decideDeveloperOutcome(result.status, hasPr);

    decision = developerDecision;
    try {
      await applyDeveloperLabels(github, issue.number, developerDecision);
      logger.job(
        {
          issue: issue.number,
          role,
          agentId: result.agentId,
          runId: result.runId,
        },
        `labels: -in-dev +${decision}`,
      );
    } catch (err) {
      logger.error({ err, issue: issue.number }, 'github labels failed');
    }

    if (developerDecision === 'in-qa') {
      await retargetChildPullIfNeeded(github, logger, issue);
    }
  }

  if (isQaRole(role)) {
    const bugIssues = extractTesterBugIssues(result.text);
    let testerDecision = decideTesterOutcome(
      result.status,
      result.text,
      bugIssues,
    );

    if (testerDecision === 'in-qa') {
      const handoff = classifyTesterBugHandoff(issue.body, bugIssues ?? []);

      if (handoff !== 'ok') {
        testerDecision = 'needs-human';
        const reason =
          handoff === 'grandchild'
            ? 'Пайплайн: тестировщик на дочернем баге (`Related to #`) ' +
              'открыл новые issues — глубина дерева QA = 1, внуки ' +
              'запрещены. Нужен человек.'
            : `Пайплайн: тестировщик создал больше ${MAX_TESTER_CHILD_BUGS} ` +
              'bug-issues за прогон (лимит). Нужен человек.';

        try {
          await github.commentOnIssue(issue.number, reason);
        } catch (err) {
          logger.error(
            { err, issue: issue.number },
            'tester handoff comment failed',
          );
        }

        logger.job(
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
          const bugs = await labelTesterBugs(
            github,
            store,
            issue,
            bugIssues ?? [],
          );

          logger.job(
            {
              issue: issue.number,
              role,
              agentId: result.agentId,
              runId: result.runId,
            },
            bugs.length
              ? `labeled tester bugs: ${bugs
                  .map((number) => `#${number}`)
                  .join(', ')}`
              : 'tester reported no bugs',
          );
        } catch (err) {
          testerDecision = 'needs-human';
          logger.error(
            { err, issue: issue.number },
            'tester bug handoff failed',
          );
        }
      }
    }

    decision = testerDecision;
    try {
      await applyTesterLabels(github, issue.number, testerDecision);
      logger.job(
        {
          issue: issue.number,
          role,
          agentId: result.agentId,
          runId: result.runId,
        },
        `labels: -qa-in-progress +${testerDecision}`,
      );
    } catch (err) {
      logger.error({ err, issue: issue.number }, 'github labels failed');
    }
  }

  if (role === 'release-manager') {
    const tag = extractReleaseTag(result.text);
    const changelog = extractReleaseChangelog(result.text);
    const expectedTag = issue.milestone
      ? tagFromMilestoneTitle(issue.milestone.title)
      : null;
    let releaseDecision = decideReleaseManagerOutcome(
      result.status,
      result.text,
      tag,
      changelog,
      expectedTag,
    );

    if (releaseDecision === 'released' && tag && changelog) {
      try {
        const releaseUrl = await applyPublishedRelease(
          github,
          issue,
          tag,
          changelog,
        );

        logger.job(
          {
            issue: issue.number,
            role,
            agentId: result.agentId,
            runId: result.runId,
          },
          `published release ${tag}: ${releaseUrl}`,
        );
      } catch (err) {
        releaseDecision = 'needs-human';
        logger.error({ err, issue: issue.number }, 'release package failed');
      }
    }

    decision = releaseDecision;

    if (releaseDecision === 'needs-human') {
      try {
        await github.addIssueLabels(issue.number, ['needs-human']);
        logger.job(
          {
            issue: issue.number,
            role,
            agentId: result.agentId,
            runId: result.runId,
          },
          'labels: +needs-human',
        );
      } catch (err) {
        logger.error({ err, issue: issue.number }, 'github labels failed');
      }
    }
  }

  if (decision) {
    await store.update(job.id, { decision });
  }

  try {
    await github.commentOnIssue(
      issue.number,
      generateJobComment({
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
    logger.error({ err, issue: issue.number }, 'github comment failed');
  }

  if (result.text?.trim()) {
    try {
      await github.commentOnIssue(
        issue.number,
        generateAgentResultComment(role, result.text),
      );
    } catch (err) {
      logger.error({ err, issue: issue.number }, 'github plan comment failed');
    }
  }
}
