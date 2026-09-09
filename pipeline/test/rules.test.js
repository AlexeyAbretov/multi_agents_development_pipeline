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
  releaseChangelog,
  releasePrNumbers,
  releaseTag,
  roleForLabels,
  testerBugIssues,
  upsertChildBugIssuesInBody,
  upsertFixRoundInBody,
} from "../dist/rules.js";
import {
  blockedNoTagComment,
  bodyHasBlockedNoTagMarker,
  isMilestoneDueOn,
  tagFromMilestoneTitle,
} from "../dist/schedule-rules.js";
import { uiStatusForJob } from "../dist/types.js";

test("testerBugIssues parses issue numbers and removes duplicates", () => {
  assert.deepEqual(
    testerBugIssues("Результат\nPIPELINE_BUG_ISSUES: #17, 18,17\nPIPELINE_LABELS: in-qa"),
    [17, 18],
  );
});

test("testerBugIssues accepts none", () => {
  assert.deepEqual(
    testerBugIssues("PIPELINE_BUG_ISSUES: none\nPIPELINE_LABELS: in-qa"),
    [],
  );
});

test("testerBugIssues rejects a missing or malformed marker", () => {
  assert.equal(testerBugIssues("PIPELINE_LABELS: in-qa"), null);
  assert.equal(testerBugIssues("PIPELINE_BUG_ISSUES: 17 and 18"), null);
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
  assert.equal(roleForLabels(["bug", "qa-passed"]), "release-manager");
});

test("analyst starts on needs-plan and skips while in-analysis", () => {
  assert.equal(roleForLabels(["bug", "needs-plan"]), "analyst");
  assert.equal(roleForLabels(["feature", "needs-plan"]), "analyst");
  assert.equal(roleForLabels(["bug", "in-analysis"]), null);
  assert.equal(roleForLabels(["bug", "needs-plan", "in-analysis"]), null);
  assert.equal(roleForLabels(["bug", "ready-for-dev"]), "developer");
  assert.equal(roleForLabels(["bug", "needs-plan", "needs-human"]), null);
});

test("release-manager starts on qa-passed only", () => {
  assert.equal(roleForLabels(["feature", "qa-passed"]), "release-manager");
  assert.equal(roleForLabels(["feature", "qa-passed", "ready-for-release"]), null);
  assert.equal(roleForLabels(["feature", "qa-passed", "release-approved"]), null);
  assert.equal(roleForLabels(["feature", "qa-passed", "needs-human"]), null);
});

test("release-manager does not start on child bugs", () => {
  assert.equal(
    roleForLabels(["bug", "qa-passed"], "Related to #14\nfix-round: 1"),
    null,
  );
  assert.equal(roleForLabels(["bug", "qa-passed"], "корневой баг без родителя"), "release-manager");
  assert.equal(roleForLabels(["feature", "qa-passed"], null), "release-manager");
});

test("release markers parse tag, PRs and changelog", () => {
  const text = [
    "Чеклист",
    "PIPELINE_RELEASE_TAG: 0.3.0",
    "PIPELINE_PR_NUMBERS: #15, 16,15",
    "PIPELINE_CHANGELOG_BEGIN",
    "## Что вошло",
    "- stage 1",
    "PIPELINE_CHANGELOG_END",
    "PIPELINE_LABELS: ready-for-release",
  ].join("\n");
  assert.equal(releaseTag(text), "v0.3.0");
  assert.deepEqual(releasePrNumbers(text), [15, 16]);
  assert.equal(releaseChangelog(text), "## Что вошло\n- stage 1");
  assert.equal(
    decideReleaseManagerOutcome("finished", text, "v0.3.0", [15, 16], "## Что вошло\n- stage 1"),
    "ready-for-release",
  );
});

test("release-manager protocol mismatch needs human", () => {
  assert.equal(
    decideReleaseManagerOutcome("finished", "PIPELINE_LABELS: ready-for-release", null, [], "x"),
    "needs-human",
  );
  assert.equal(
    decideReleaseManagerOutcome(
      "finished",
      "PIPELINE_RELEASE_TAG: v1.0.0\nPIPELINE_PR_NUMBERS: none\nPIPELINE_LABELS: ready-for-release",
      "v1.0.0",
      [],
      null,
    ),
    "needs-human",
  );
  assert.equal(
    decideReleaseManagerOutcome("error", "PIPELINE_LABELS: ready-for-release", "v1.0.0", [], "body"),
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
  assert.equal(isMilestoneDueOn("2026-09-08", new Date("2026-09-08T12:00:00Z")), true);
  assert.equal(isMilestoneDueOn("2026-09-07", new Date("2026-09-08T12:00:00Z")), false);
  assert.equal(isMilestoneDueOn(null), false);
  assert.equal(tagFromMilestoneTitle("v0.3"), "v0.3");
  assert.equal(tagFromMilestoneTitle("0.3.1"), "v0.3.1");
  assert.equal(tagFromMilestoneTitle("Release party"), null);
  assert.match(blockedNoTagComment("v0.3", 99), /blocked: no tag/);
  assert.equal(bodyHasBlockedNoTagMarker(blockedNoTagComment("v0.3", 99), 99), true);
});

test("uiStatusForJob maps release-manager approval and failures", () => {
  assert.equal(uiStatusForJob({ status: "queued", decision: null, role: "analyst" }), "queued");
  assert.equal(uiStatusForJob({ status: "running", decision: null, role: "developer" }), "running");
  assert.equal(
    uiStatusForJob({
      status: "finished",
      decision: "ready-for-release",
      role: "release-manager",
    }),
    "waiting-approval",
  );
  assert.equal(
    uiStatusForJob({ status: "finished", decision: "needs-human", role: "tester" }),
    "failed",
  );
  assert.equal(uiStatusForJob({ status: "error", decision: null, role: "analyst" }), "failed");
});
