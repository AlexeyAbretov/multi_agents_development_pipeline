import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DeployRequest = {
  tag: string;
  milestoneId: number;
  milestoneTitle: string;
  requestedAt: string;
  status: "pending" | "done" | "skipped";
};

type StoreFile = {
  requests: DeployRequest[];
};

export class DeployRequestStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "deploy-requests.json");
  }

  load(): StoreFile {
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
    } catch {
      return { requests: [] };
    }
  }

  private save(data: StoreFile): void {
    const tmp = `${this.filePath}.tmp`;

    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  hasOpenOrDoneForTag(tag: string): boolean {
    return this.load().requests.some(
      (item) => item.tag === tag && (item.status === "pending" || item.status === "done"),
    );
  }

  enqueue(params: {
    tag: string;
    milestoneId: number;
    milestoneTitle: string;
  }): DeployRequest | null {
    const data = this.load();

    if (
      data.requests.some(
        (item) =>
          item.tag === params.tag && (item.status === "pending" || item.status === "done"),
      )
    ) {
      return null;
    }

    const request: DeployRequest = {
      tag: params.tag,
      milestoneId: params.milestoneId,
      milestoneTitle: params.milestoneTitle,
      requestedAt: new Date().toISOString(),
      status: "pending",
    };

    data.requests.push(request);
    this.save(data);

    return request;
  }

  pending(): DeployRequest[] {
    return this.load().requests.filter((item) => item.status === "pending");
  }

  mark(tag: string, requestedAt: string, status: "done" | "skipped"): void {
    const data = this.load();
    const item = data.requests.find(
      (entry) => entry.tag === tag && entry.requestedAt === requestedAt,
    );

    if (!item) {
      return;
    }

    item.status = status;
    this.save(data);
  }
}
