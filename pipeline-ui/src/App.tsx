import { useEffect, useState } from "react";
import {
  fetchDeploys,
  fetchJobs,
  type DeploysResponse,
  type JobsResponse,
  type PipelineJob,
  type UiJobStatus,
} from "./api";

const STATUS_LABEL: Record<UiJobStatus, string> = {
  queued: "в очереди",
  running: "выполняется",
  "waiting-approval": "ожидает апрува",
  failed: "ошибка",
  finished: "готово",
};

function statusClass(status: UiJobStatus): string {
  switch (status) {
    case "running":
      return "text-amber-800 bg-amber-100";
    case "waiting-approval":
      return "text-accent bg-orange-100";
    case "failed":
      return "text-red-800 bg-red-100";
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

export function App() {
  const [data, setData] = useState<JobsResponse | null>(null);
  const [deploys, setDeploys] = useState<DeploysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [jobs, deployData] = await Promise.all([fetchJobs(), fetchDeploys()]);
        if (!cancelled) {
          setData(jobs);
          setDeploys(deployData);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
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

      {error ? (
        <p className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          Не удалось загрузить данные: {error}. Проверьте оркестратор на :3020.
        </p>
      ) : null}

      <section className="mb-12">
        <h2 className="mb-4 text-lg font-semibold text-ink-900">Джобы</h2>
        <JobsTable jobs={data?.jobs ?? []} />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-ink-900">Деплои</h2>
        <DeploysPanel data={deploys} />
      </section>
    </div>
  );
}

function JobsTable({ jobs }: { jobs: PipelineJob[] }) {
  if (jobs.length === 0) {
    return (
      <p className="text-sm text-ink-700">Пока нет записей в jobs.json — дождитесь полла.</p>
    );
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
          {jobs.map((job) => (
            <tr key={job.id} className="border-b border-ink-100 last:border-0">
              <td className="px-4 py-3 font-medium">
                {job.issueUrl ? (
                  <a
                    className="text-ink-900 underline decoration-ink-200 underline-offset-2 hover:decoration-accent"
                    href={job.issueUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    #{job.issue}
                  </a>
                ) : (
                  `#${job.issue}`
                )}
              </td>
              <td className="px-4 py-3">{job.role}</td>
              <td className="px-4 py-3">
                <span
                  className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${statusClass(job.uiStatus)}`}
                >
                  {STATUS_LABEL[job.uiStatus]}
                </span>
                {job.error ? (
                  <p className="mt-1 max-w-xs truncate text-xs text-red-700" title={job.error}>
                    {job.error}
                  </p>
                ) : null}
              </td>
              <td className="px-4 py-3 text-ink-700">{job.decision ?? "—"}</td>
              <td className="px-4 py-3">
                <div className="flex flex-col gap-1">
                  {job.agentUrl ? (
                    <a
                      className="text-accent underline-offset-2 hover:underline"
                      href={job.agentUrl}
                      target="_blank"
                      rel="noreferrer"
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
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-ink-700">
                {formatTime(job.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeploysPanel({ data }: { data: DeploysResponse | null }) {
  if (!data) {
    return <p className="text-sm text-ink-700">Загрузка…</p>;
  }
  if (data.deploys.length === 0 && data.requests.length === 0) {
    return <p className="text-sm text-ink-700">Деплов пока нет.</p>;
  }
  return (
    <div className="space-y-4">
      {data.requests.some((item) => item.status === "pending") ? (
        <ul className="text-sm text-ink-700">
          {data.requests
            .filter((item) => item.status === "pending")
            .map((item) => (
              <li key={`${item.tag}-${item.requestedAt}`}>
                В очереди: <span className="font-medium text-ink-900">{item.tag}</span> (
                {item.milestoneTitle})
              </li>
            ))}
        </ul>
      ) : null}
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
