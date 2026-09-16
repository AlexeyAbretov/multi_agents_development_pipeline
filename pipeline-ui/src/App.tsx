import { Fragment, useEffect, useState } from "react";
import {
  fetchDeploys,
  fetchJobs,
  type DeploysResponse,
  type JobsResponse,
  type PipelineJob,
  type UiJobStatus,
} from "./api";
import { groupJobsByIssue, rewriteIssueUrl, type JobGroup } from "./jobGroups";

const STATUS_LABEL: Record<UiJobStatus, string> = {
  queued: "в очереди",
  running: "выполняется",
  failed: "ошибка",
  finished: "готово",
  clarification: "уточнение",
};

function statusClass(status: UiJobStatus): string {
  switch (status) {
    case "running":
      return "text-amber-800 bg-amber-100";
    case "failed":
      return "text-red-800 bg-red-100";
    case "clarification":
      return "text-sky-900 bg-sky-100";
    case "queued":
      return "text-ink-700 bg-ink-100";
    default:
      return "text-emerald-900 bg-emerald-100";
  }
}

function formatTime(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  try {
    return new Date(iso).toLocaleString("ru-RU");
  } catch {
    return iso;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function App() {
  const [data, setData] = useState<JobsResponse | null>(null);
  const [deploys, setDeploys] = useState<DeploysResponse | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [deploysError, setDeploysError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadJobs = async () => {
      try {
        const jobs = await fetchJobs();
        if (!cancelled) {
          setData(jobs);
          setJobsError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setJobsError(errorText(err));
        }
      }
    };

    const loadDeploys = async () => {
      try {
        const deployData = await fetchDeploys();
        if (!cancelled) {
          setDeploys(deployData);
          setDeploysError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setDeploysError(errorText(err));
        }
      }
    };

    const load = () => {
      void loadJobs();
      void loadDeploys();
    };

    load();
    const timer = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-10 border-b border-ink-200 pb-8">
        <p className="font-display text-4xl font-bold tracking-tight text-ink-900 sm:text-5xl">
          Пайплайн
        </p>
        <p className="mt-3 max-w-xl text-base text-ink-700">
          Очередь облачных ролей и деплоев. Релиз публикует релиз-менеджер по milestone
          (<code className="text-sm">vN.N.N</code>), здесь лишь статус.
        </p>
        <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-sm text-ink-700">
          <div>
            <dt className="inline text-ink-200">репо </dt>
            <dd className="inline font-medium text-ink-900">{data?.githubRepo ?? "—"}</dd>
          </div>
          <div>
            <dt className="inline text-ink-200">последний полл </dt>
            <dd className="inline font-medium text-ink-900">{formatTime(data?.lastPollAt ?? null)}</dd>
          </div>
        </dl>
      </header>

      {jobsError ? (
        <p className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          Не удалось загрузить джобы: {jobsError}. Проверьте оркестратор.
        </p>
      ) : null}

      <section className="mb-12">
        <h2 className="mb-4 text-lg font-semibold text-ink-900">Джобы</h2>
        <JobsTable jobs={data?.jobs ?? []} />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-ink-900">Деплои</h2>
        {deploysError ? (
          <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
            Не удалось загрузить деплои: {deploysError}. Проверьте deployer.
          </p>
        ) : null}
        <DeploysPanel data={deploys} error={deploysError} />
      </section>
    </div>
  );
}

function IssueLink({
  issue,
  url,
}: {
  issue: number;
  url: string | null;
}) {
  if (!url) {
    return <>#{issue}</>;
  }

  return (
    <a
      className="text-ink-900 underline decoration-ink-200 underline-offset-2 hover:decoration-accent"
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      #{issue}
    </a>
  );
}

function StatusBadge({ status }: { status: UiJobStatus }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${statusClass(status)}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function JobLinks({ job }: { job: PipelineJob }) {
  return (
    <div className="flex flex-col gap-1">
      {job.agentUrl ? (
        <a
          className="text-accent underline-offset-2 hover:underline"
          href={job.agentUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          Cursor {job.agentId?.slice(0, 10)}…
        </a>
      ) : (
        <span className="text-ink-200">Cursor —</span>
      )}
      {job.runId ? (
        <span className="font-mono text-xs text-ink-700" title={job.runId}>
          run {job.runId.slice(0, 12)}…
        </span>
      ) : null}
    </div>
  );
}

function JobRow({ job, groupIssue }: { job: PipelineJob; groupIssue: number }) {
  return (
    <tr className="border-b border-ink-100 last:border-0 bg-white">
      <td className="px-4 py-3 pl-9 font-medium">
        {job.issue === groupIssue ? null : (
          <IssueLink issue={job.issue} url={job.issueUrl} />
        )}
      </td>
      <td className="px-4 py-3">{job.role}</td>
      <td className="px-4 py-3">
        <StatusBadge status={job.uiStatus} />
        {job.error ? (
          <p className="mt-1 max-w-xs truncate text-xs text-red-700" title={job.error}>
            {job.error}
          </p>
        ) : null}
      </td>
      <td className="px-4 py-3 text-ink-700">{job.decision ?? "—"}</td>
      <td className="px-4 py-3">
        <JobLinks job={job} />
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-ink-700">
        {formatTime(job.updatedAt)}
      </td>
    </tr>
  );
}

function GroupIssueCell({ group }: { group: JobGroup }) {
  const sampleUrl = group.jobs[0]?.issueUrl ?? null;
  const groupUrl = rewriteIssueUrl(sampleUrl, group.issue);

  return (
    <div>
      <span className="font-medium">
        <IssueLink issue={group.issue} url={groupUrl} />
      </span>
      {group.relatedIssues.length > 0 ? (
        <p className="mt-1 text-xs text-ink-700">
          связанные{" "}
          {group.relatedIssues.map((issue, index) => (
            <span key={issue}>
              {index > 0 ? ", " : null}
              <IssueLink issue={issue} url={rewriteIssueUrl(sampleUrl, issue)} />
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

function JobsTable({ jobs }: { jobs: PipelineJob[] }) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const groups = groupJobsByIssue(jobs);

  if (jobs.length === 0) {
    return (
      <p className="text-sm text-ink-700">Пока нет записей в jobs.json — дождитесь полла.</p>
    );
  }

  function toggleGroup(issue: number) {
    setCollapsed((current) => {
      const next = new Set(current);

      if (next.has(issue)) {
        next.delete(issue);
      } else {
        next.add(issue);
      }

      return next;
    });
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-ink-200 bg-white/80 shadow-sm">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-ink-200 bg-ink-50/80 text-xs uppercase tracking-wide text-ink-700">
          <tr>
            <th className="px-4 py-3 font-medium">Issue</th>
            <th className="px-4 py-3 font-medium">Роль</th>
            <th className="px-4 py-3 font-medium">Статус</th>
            <th className="px-4 py-3 font-medium">Решение</th>
            <th className="px-4 py-3 font-medium">Ссылки</th>
            <th className="px-4 py-3 font-medium">Обновлён</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const expanded = !collapsed.has(group.issue);
            const active = group.activeJobs;

            return (
              <Fragment key={group.issue}>
                <tr
                  className="cursor-pointer border-b border-ink-100 bg-ink-50/70 hover:bg-ink-100/80"
                  onClick={() => toggleGroup(group.issue)}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 inline-block w-3 text-xs text-ink-700">
                        {expanded ? "▾" : "▸"}
                      </span>
                      <GroupIssueCell group={group} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {active.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {active.map((job) => (
                          <span key={job.id}>{job.role}</span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-ink-200">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {active.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {active.map((job) => (
                          <StatusBadge key={job.id} status={job.uiStatus} />
                        ))}
                      </div>
                    ) : (
                      <span className="text-ink-200">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-200">—</td>
                  <td className="px-4 py-3 text-ink-200">—</td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink-700">
                    {formatTime(group.updatedAt)}
                  </td>
                </tr>
                {expanded
                  ? group.jobs.map((job) => (
                      <JobRow key={job.id} job={job} groupIssue={group.issue} />
                    ))
                  : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DeploysPanel({
  data,
  error,
}: {
  data: DeploysResponse | null;
  error: string | null;
}) {
  if (!data) {
    if (error) {
      return null;
    }
    return <p className="text-sm text-ink-700">Загрузка…</p>;
  }
  if (data.deploys.length === 0) {
    return <p className="text-sm text-ink-700">Деплов пока нет.</p>;
  }
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-ink-200 bg-white/80 shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-ink-200 bg-ink-50/80 text-xs uppercase tracking-wide text-ink-700">
            <tr>
              <th className="px-4 py-3 font-medium">Tag</th>
              <th className="px-4 py-3 font-medium">Статус</th>
              <th className="px-4 py-3 font-medium">Режим</th>
              <th className="px-4 py-3 font-medium">Когда</th>
            </tr>
          </thead>
          <tbody>
            {data.deploys.map((item) => (
              <tr key={`${item.tag}-${item.at}`} className="border-b border-ink-100 last:border-0">
                <td className="px-4 py-3 font-medium">{item.tag}</td>
                <td className="px-4 py-3">{item.status}</td>
                <td className="px-4 py-3">{item.mode}</td>
                <td className="px-4 py-3 whitespace-nowrap">{formatTime(item.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
