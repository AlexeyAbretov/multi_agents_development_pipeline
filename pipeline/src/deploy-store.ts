import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DeployRecord = {
  /** GitHub release id, or 0 for schedule/tag-only deploy. */
  releaseId: number;
  tag: string;
  status: "deployed" | "deploy-failed";
  mode: string;
  detail: string;
  at: string;
};

type StoreFile = {
  deploys: DeployRecord[];
};

export class DeployStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "deploys.json");
  }

  load(): StoreFile {
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
    } catch {
      return { deploys: [] };
    }
  }

  private save(data: StoreFile): void {
    const tmp = `${this.filePath}.tmp`;

    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  has(releaseId: number): boolean {
    if (releaseId === 0) {
      return false;
    }

    return this.load().deploys.some((item) => item.releaseId === releaseId);
  }

  hasTag(tag: string): boolean {
    return this.load().deploys.some((item) => item.tag === tag);
  }

  hasSuccessfulTag(tag: string): boolean {
    return this.load().deploys.some(
      (item) => item.tag === tag && item.status === "deployed",
    );
  }

  deployedIds(): Set<number> {
    return new Set(
      this.load()
        .deploys.filter((item) => item.releaseId !== 0)
        .map((item) => item.releaseId),
    );
  }

  record(entry: DeployRecord): void {
    const data = this.load();

    data.deploys = data.deploys.filter((item) => {
      if (entry.releaseId !== 0 && item.releaseId === entry.releaseId) {
        return false;
      }

      if (item.tag === entry.tag) {
        return false;
      }

      return true;
    });
    data.deploys.push(entry);
    this.save(data);
  }
}
