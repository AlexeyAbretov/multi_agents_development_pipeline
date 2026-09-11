import assert from "node:assert/strict";
import test from "node:test";
import {
  appendDeployNote,
  isDeployableRelease,
  releaseBodyHasDeployMarker,
  releasesToDeploy,
} from "../dist/deploy-rules.js";
import {
  childBugStillOpen,
  childBlocksParentReQa,
  classifyTesterBugHandoff,
  decideReleaseManagerOutcome,
  decideTesterOutcome,
  fixRoundBlocksDeveloper,
  groupAnalystIssuesByParent,
  isChildBugCandidate,
  parseChildBugIssues,
  parseFixRound,
  parseRelatedParentIssue,
  shouldCloseMergedChildIssue,
  extractReleaseChangelog,
  extractReleasePrNumbers,
  extractReleaseTag,
  roleForLabels,
  extractTesterBugIssues,
  mapJobToUiStatus,
  upsertChildBugIssuesInBody,
  upsertFixRoundInBody,
} from "../dist/rules.js";
import {
  blockedNoReleaseComment,
  bodyHasBlockedNoReleaseMarker,
  calendarDateInTimeZone,
  daysUntilDue,
  decideReleaseGate,
  isEmptySincePreviousRelease,
  isMilestoneDueOn,
  isRegressionIssue,
  nothingToReleaseComment,
  previousReleaseTag,
  tagFromMilestoneTitle,
  upsertNothingToReleaseDescription,
} from "../dist/schedule-rules.js";

test("extractTesterBugIssues parses issue numbers and removes duplicates", () => {
  assert.deepEqual(
    extractTesterBugIssues("Результат\nPIPELINE_BUG_ISSUES: #17, 18,17\nPIPELINE_LABELS: in-qa"),
    [17, 18],
  );
});

test("extractTesterBugIssues accepts none", () => {
  assert.deepEqual(
    extractTesterBugIssues("PIPELINE_BUG_ISSUES: none\nPIPELINE_LABELS: in-qa"),
    [],
  );
});

test("extractTesterBugIssues rejects a missing or malformed marker", () => {
  assert.equal(extractTesterBugIssues("PIPELINE_LABELS: in-qa"), null);
  assert.equal(extractTesterBugIssues("PIPELINE_BUG_ISSUES: 17 and 18"), null);
});

test("tester passes QA only with no bugs and matching marker", () => {
  assert.equal(
    decideTesterOutcome(
      "finished",
      "PIPELINE_BUG_ISSUES: none\nPIPELINE_LABELS: qa-passed",
      [],
    ),
    "qa-passed",
  );
  assert.equal(
    decideTesterOutcome(
      "finished",
      "PIPELINE_BUG_ISSUES: 17\nPIPELINE_LABELS: in-qa",
      [17],
    ),
    "in-qa",
  );
});

test("tester protocol mismatch needs human", () => {
  assert.equal(decideTesterOutcome("finished", "PIPELINE_LABELS: qa-passed", null), "needs-human");
  assert.equal(
    decideTesterOutcome(
      "finished",
      "PIPELINE_BUG_ISSUES: 17\nPIPELINE_LABELS: qa-passed",
      [17],
    ),
    "needs-human",
  );
});

test("QA in progress and passed states do not retrigger tester", () => {
  assert.equal(roleForLabels(["bug", "in-qa"]), "tester");
  assert.equal(roleForLabels(["bug", "in-qa", "qa-in-progress"]), null);
  assert.equal(roleForLabels(["bug", "qa-passed"]), null);
});

test("analyst starts on needs-plan and skips while in-analysis", () => {
  assert.equal(roleForLabels(["bug", "needs-plan"]), "analyst");
  assert.equal(roleForLabels(["feature", "needs-plan"]), "analyst");
  assert.equal(roleForLabels(["bug", "in-analysis"]), null);
  assert.equal(roleForLabels(["bug", "needs-plan", "in-analysis"]), null);
  assert.equal(roleForLabels(["bug", "ready-for-dev"]), "developer");
  assert.equal(roleForLabels(["bug", "in-dev"]), null);
  assert.equal(roleForLabels(["bug", "ready-for-dev", "in-dev"]), null);
  assert.equal(roleForLabels(["bug", "needs-plan", "needs-human"]), null);
});

test("release-manager starts on regression qa-passed only", () => {
  assert.equal(roleForLabels(["feature", "qa-passed"]), null);
  assert.equal(roleForLabels(["regression", "qa-passed"]), "release-manager");
  assert.equal(roleForLabels(["regression", "in-qa"]), "tester");
  assert.equal(roleForLabels(["regression", "qa-passed", "needs-human"]), null);
});

test("release-manager does not start on feature or child bugs", () => {
  assert.equal(
    roleForLabels(["bug", "qa-passed"], "Related to #14\nfix-round: 1"),
    null,
  );
  assert.equal(roleForLabels(["bug", "qa-passed"], "корневой баг без родителя"), null);
  assert.equal(roleForLabels(["feature", "qa-passed"], null), null);
});

test("release markers parse tag and changelog", () => {
  const text = [
    "Чеклист",
    "PIPELINE_RELEASE_TAG: 1.2.0",
    "PIPELINE_CHANGELOG_BEGIN",
    "## Что вошло",
    "- stage 1",
    "PIPELINE_CHANGELOG_END",
    "PIPELINE_LABELS: released",
  ].join("\n");
  assert.equal(extractReleaseTag(text), "v1.2.0");
  assert.deepEqual(extractReleasePrNumbers(text), null);
  assert.equal(extractReleaseChangelog(text), "## Что вошло\n- stage 1");
  assert.equal(
    decideReleaseManagerOutcome("finished", text, "v1.2.0", "## Что вошло\n- stage 1", "v1.2.0"),
    "released",
  );
});

test("release-manager protocol mismatch needs human", () => {
  assert.equal(
    decideReleaseManagerOutcome("finished", "PIPELINE_LABELS: released", null, "x"),
    "needs-human",
  );
  assert.equal(
    decideReleaseManagerOutcome(
      "finished",
      "PIPELINE_RELEASE_TAG: v1.0.0\nPIPELINE_LABELS: released",
      "v1.0.0",
      null,
    ),
    "needs-human",
  );
  assert.equal(
    decideReleaseManagerOutcome(
      "finished",
      "PIPELINE_RELEASE_TAG: v1.0.0\nPIPELINE_CHANGELOG_BEGIN\nnotes\nPIPELINE_CHANGELOG_END\nPIPELINE_LABELS: released",
      "v1.0.0",
      "notes",
      "v1.2.0",
    ),
    "needs-human",
  );
  assert.equal(
    decideReleaseManagerOutcome("error", "PIPELINE_LABELS: released", "v1.0.0", "body"),
    "needs-human",
  );
});

test("draft releases are not deployable", () => {
  assert.equal(isDeployableRelease({ draft: true, tag_name: "v0.1.0" }), false);
  assert.equal(isDeployableRelease({ draft: false, tag_name: "v0.1.0" }), true);
});

test("releasesToDeploy skips drafts and already deployed ids", () => {
  const pending = releasesToDeploy(
    [
      {
        id: 1,
        tag_name: "v0.1.0",
        name: null,
        body: null,
        html_url: "https://example/1",
        draft: true,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      },
      {
        id: 2,
        tag_name: "v0.2.0",
        name: null,
        body: null,
        html_url: "https://example/2",
        draft: false,
        prerelease: true,
        published_at: "2026-01-02T00:00:00Z",
      },
      {
        id: 3,
        tag_name: "v0.3.0",
        name: null,
        body: null,
        html_url: "https://example/3",
        draft: false,
        prerelease: false,
        published_at: "2026-01-03T00:00:00Z",
      },
    ],
    new Set([2]),
  );
  assert.deepEqual(
    pending.map((item) => item.id),
    [3],
  );
});

test("deploy marker round-trip on release body", () => {
  const body = appendDeployNote("notes", 42, "deployed", "stub ok");
  assert.equal(releaseBodyHasDeployMarker(body, 42), true);
  assert.equal(releaseBodyHasDeployMarker(body, 41), false);
  assert.match(body, /Локальный деплой: `deployed`/);
});

test("fix-round parses and blocks after MAX rounds", () => {
  assert.equal(parseFixRound(null), null);
  assert.equal(parseFixRound("fix-round: 2\n"), 2);
  assert.equal(fixRoundBlocksDeveloper(null), false);
  assert.equal(fixRoundBlocksDeveloper("fix-round: 2"), false);
  assert.equal(fixRoundBlocksDeveloper("fix-round: 3"), true);
  assert.equal(fixRoundBlocksDeveloper(upsertFixRoundInBody("task", 3)), true);
  assert.match(upsertFixRoundInBody("task", 1), /fix-round: 1/);
});

test("child bug markers and open detection", () => {
  const body = upsertChildBugIssuesInBody("parent", [17, 18, 17]);
  assert.deepEqual(parseChildBugIssues(body), [17, 18]);
  assert.equal(childBugStillOpen(["bug", "needs-plan"], "open"), true);
  assert.equal(childBugStillOpen(["bug", "in-analysis"], "open"), true);
  assert.equal(childBugStillOpen(["bug", "qa-passed"], "open"), false);
  assert.equal(childBugStillOpen(["bug", "in-qa"], "closed"), false);
  assert.equal(childBugStillOpen(["bug", "needs-human"], "open"), false);
});

test("open child PR blocks parent re-QA even after qa-passed", () => {
  assert.equal(childBlocksParentReQa(["bug", "qa-passed"], "open", true), true);
  assert.equal(childBlocksParentReQa(["bug", "qa-passed"], "open", false), false);
  assert.equal(childBlocksParentReQa(["bug", "in-qa"], "open", false), true);
});

test("shouldCloseMergedChildIssue only for child qa-passed with merged PR", () => {
  assert.equal(
    shouldCloseMergedChildIssue({
      body: "Related to #14",
      labels: ["bug", "qa-passed"],
      hasOpenFixPr: false,
      hasMergedFixPr: true,
    }),
    true,
  );
  assert.equal(
    shouldCloseMergedChildIssue({
      body: "Related to #14",
      labels: ["bug", "qa-passed"],
      hasOpenFixPr: true,
      hasMergedFixPr: true,
    }),
    false,
  );
  assert.equal(
    shouldCloseMergedChildIssue({
      body: "корневая фича",
      labels: ["feature", "qa-passed"],
      hasOpenFixPr: false,
      hasMergedFixPr: true,
    }),
    false,
  );
});

test("classifyTesterBugHandoff limits tree depth and count", () => {
  assert.equal(classifyTesterBugHandoff("feature root", []), "ok");
  assert.equal(classifyTesterBugHandoff("feature root", [48, 49]), "ok");
  assert.equal(classifyTesterBugHandoff("feature root", [48, 49, 50]), "too-many");
  assert.equal(classifyTesterBugHandoff("Related to #14", [52]), "grandchild");
  assert.equal(classifyTesterBugHandoff("Related to #14", []), "ok");
});

test("parseRelatedParentIssue and child bug candidate", () => {
  assert.equal(parseRelatedParentIssue("Related to #7\nbug text"), 7);
  assert.equal(parseRelatedParentIssue("related to #42"), 42);
  assert.equal(parseRelatedParentIssue("Related to # 7"), null);
  assert.equal(parseRelatedParentIssue(null), null);

  assert.equal(
    isChildBugCandidate({
      labels: ["bug", "needs-plan"],
      body: "Related to #7",
    }),
    true,
  );
  assert.equal(
    isChildBugCandidate({
      labels: ["feature", "needs-plan"],
      body: "Related to #7",
    }),
    false,
  );
  assert.equal(
    isChildBugCandidate({
      labels: ["bug", "needs-plan"],
      body: "no parent link",
    }),
    false,
  );
});

test("groupAnalystIssuesByParent batches sibling child bugs", () => {
  const child = (number, parent) => ({
    number,
    labels: ["bug", "needs-plan"],
    body: `Related to #${parent}`,
  });
  const standaloneIssue = {
    number: 34,
    labels: ["feature", "needs-plan"],
    body: "новая фича",
  };

  const batches = groupAnalystIssuesByParent([child(29, 7), child(30, 7), standaloneIssue]);
  assert.equal(batches.length, 2);
  const sibling = batches.find((batch) => batch.length === 2);
  assert.deepEqual(
    sibling?.map((item) => item.number).sort((a, b) => a - b),
    [29, 30],
  );
  const solo = batches.find((batch) => batch.length === 1);
  assert.equal(solo?.[0]?.number, 34);
});

test("milestone due and tag from title", () => {
  assert.equal(isMilestoneDueOn("2026-09-08", new Date("2026-09-08T12:00:00Z"), "UTC"), true);
  assert.equal(isMilestoneDueOn("2026-09-07", new Date("2026-09-08T12:00:00Z"), "UTC"), false);
  assert.equal(isMilestoneDueOn(null), false);
  assert.equal(tagFromMilestoneTitle("v0.3"), null);
  assert.equal(tagFromMilestoneTitle("0.3.1"), null);
  assert.equal(tagFromMilestoneTitle("v1.2.0"), "v1.2.0");
  assert.equal(tagFromMilestoneTitle("Release party"), null);
  assert.match(blockedNoReleaseComment("v1.2.0", 99), /blocked: no release/);
  assert.equal(bodyHasBlockedNoReleaseMarker(blockedNoReleaseComment("v1.2.0", 99), 99), true);
  assert.equal(daysUntilDue("2026-09-09T00:00:00Z", "UTC", new Date("2026-09-08T12:00:00Z")), 1);
  assert.equal(daysUntilDue("2026-09-08T00:00:00Z", "UTC", new Date("2026-09-08T12:00:00Z")), 0);
  assert.equal(isRegressionIssue(["regression"], null), true);
  assert.equal(isRegressionIssue(["bug"], "<!-- pipeline:regression:12 -->"), true);
  assert.equal(calendarDateInTimeZone(new Date("2026-09-08T22:00:00Z"), "Europe/Moscow"), "2026-09-09");
});

test("decideReleaseGate calendar rules", () => {
  const base = {
    labels: ["regression", "qa-passed"],
    milestoneTitle: "v1.2.0",
    dueOn: "2026-09-08T00:00:00Z",
    timeZone: "UTC",
    dueTodayCount: 1,
    hasOpenWorkItems: false,
    releaseExists: false,
    now: new Date("2026-09-08T12:00:00Z"),
  };
  assert.equal(decideReleaseGate(base), "ok");
  assert.equal(decideReleaseGate({ ...base, dueTodayCount: 2 }), "duplicate-due");
  assert.equal(decideReleaseGate({ ...base, hasOpenWorkItems: true }), "open-work");
  assert.equal(decideReleaseGate({ ...base, dueOn: "2026-09-09T00:00:00Z" }), "not-due-today");
  assert.equal(decideReleaseGate({ ...base, labels: ["feature", "qa-passed"] }), "not-regression");
  assert.equal(decideReleaseGate({ ...base, labels: ["regression", "in-qa"] }), "regression-not-passed");
  assert.equal(decideReleaseGate({ ...base, releaseExists: true }), "already-released");
  assert.equal(decideReleaseGate({ ...base, milestoneTitle: "v0.3" }), "bad-title");
  assert.equal(decideReleaseGate({ ...base, nothingToRelease: true }), "nothing-to-release");
});

test("empty since previous release", () => {
  assert.equal(isEmptySincePreviousRelease({ previousTag: null, aheadBy: 0 }), false);
  assert.equal(isEmptySincePreviousRelease({ previousTag: "v1.0.0", aheadBy: null }), false);
  assert.equal(isEmptySincePreviousRelease({ previousTag: "v1.0.0", aheadBy: 0 }), true);
  assert.equal(isEmptySincePreviousRelease({ previousTag: "v1.0.0", aheadBy: 3 }), false);
  assert.equal(
    previousReleaseTag(
      [
        { tag_name: "v1.1.0", published_at: "2026-09-08T00:00:00Z" },
        { tag_name: "v1.0.0", published_at: "2026-08-01T00:00:00Z" },
      ],
      "v1.1.0",
    ),
    "v1.0.0",
  );
  const note = nothingToReleaseComment("v1.2.0", "v1.0.0", 7);
  assert.match(note, /нет новых коммитов/);
  assert.match(upsertNothingToReleaseDescription("цель", note), /цель/);
  assert.equal(upsertNothingToReleaseDescription(note, note), note);
});

test("mapJobToUiStatus maps release-manager and failures", () => {
  assert.equal(mapJobToUiStatus({ status: "queued", decision: null }), "queued");
  assert.equal(mapJobToUiStatus({ status: "running", decision: null }), "running");
  assert.equal(
    mapJobToUiStatus({
      status: "finished",
      decision: "released",
    }),
    "finished",
  );
  assert.equal(
    mapJobToUiStatus({ status: "finished", decision: "needs-human" }),
    "failed",
  );
  assert.equal(mapJobToUiStatus({ status: "error", decision: null }), "failed");
});
