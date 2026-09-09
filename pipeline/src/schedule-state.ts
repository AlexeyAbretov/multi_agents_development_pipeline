import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type StoreFile = {
  /** Milestone ids that already received blocked: no release comments. */
  blockedNotified: number[];
  /** Calendar days (YYYY-MM-DD in SCHEDULE_TZ) that already got duplicate-due comments. */
  duplicateDueNotified: string[];
};

export class ScheduleStateStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "schedule-state.json");
  }

  load(): StoreFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreFile>;
      return {
        blockedNotified: parsed.blockedNotified ?? [],
        duplicateDueNotified: parsed.duplicateDueNotified ?? [],
      };
    } catch {
      return { blockedNotified: [], duplicateDueNotified: [] };
    }
  }

  private save(data: StoreFile): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  wasBlockedNotified(milestoneId: number): boolean {
    return this.load().blockedNotified.includes(milestoneId);
  }

  markBlockedNotified(milestoneId: number): void {
    const data = this.load();
    if (!data.blockedNotified.includes(milestoneId)) {
      data.blockedNotified.push(milestoneId);
      this.save(data);
    }
  }

  wasDuplicateDueNotified(day: string): boolean {
    return this.load().duplicateDueNotified.includes(day);
  }

  markDuplicateDueNotified(day: string): void {
    const data = this.load();
    if (!data.duplicateDueNotified.includes(day)) {
      data.duplicateDueNotified.push(day);
      this.save(data);
    }
  }
}
