import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { Document } from 'mongodb';

import type { MongodbClient } from '@providers';

const META_COLLECTION = 'meta';
const SCHEDULE_META_ID = 'schedule';

type ScheduleState = {
  /** Milestone ids that already received blocked: no release comments. */
  blockedNotified: number[];
  /**
   * Calendar days (YYYY-MM-DD in SCHEDULE_TZ) that already got
   * duplicate-due comments.
   */
  duplicateDueNotified: string[];
};

type ScheduleMeta = Document &
  ScheduleState & {
    _id: string;
  };

type LegacyStoreFile = Partial<ScheduleState>;

export class ScheduleStateStore {
  constructor(private readonly mongo: MongodbClient) {}

  private metaCol() {
    return this.mongo.collection<ScheduleMeta>(META_COLLECTION);
  }

  private async load(): Promise<ScheduleState> {
    const parsed = await this.metaCol().findOne({ _id: SCHEDULE_META_ID });

    return {
      blockedNotified: parsed?.blockedNotified ?? [],
      duplicateDueNotified: parsed?.duplicateDueNotified ?? [],
    };
  }

  private async save(data: ScheduleState): Promise<void> {
    await this.metaCol().updateOne(
      { _id: SCHEDULE_META_ID },
      {
        $set: {
          blockedNotified: data.blockedNotified,
          duplicateDueNotified: data.duplicateDueNotified,
        },
      },
      { upsert: true },
    );
  }

  async wasBlockedNotified(milestoneId: number): Promise<boolean> {
    const data = await this.load();

    return data.blockedNotified.includes(milestoneId);
  }

  async markBlockedNotified(milestoneId: number): Promise<void> {
    const data = await this.load();

    if (data.blockedNotified.includes(milestoneId)) {
      return;
    }

    data.blockedNotified.push(milestoneId);
    await this.save(data);
  }

  async wasDuplicateDueNotified(day: string): Promise<boolean> {
    const data = await this.load();

    return data.duplicateDueNotified.includes(day);
  }

  async markDuplicateDueNotified(day: string): Promise<void> {
    const data = await this.load();

    if (data.duplicateDueNotified.includes(day)) {
      return;
    }

    data.duplicateDueNotified.push(day);
    await this.save(data);
  }

  async importLegacyJson(dataDir: string): Promise<number> {
    const data = await this.load();

    if (
      data.blockedNotified.length > 0 ||
      data.duplicateDueNotified.length > 0
    ) {
      return 0;
    }

    const filePath = join(dataDir, 'schedule-state.json');
    let raw: string;

    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return 0;
    }

    const parsed = JSON.parse(raw) as LegacyStoreFile;
    const next: ScheduleState = {
      blockedNotified: parsed.blockedNotified ?? [],
      duplicateDueNotified: parsed.duplicateDueNotified ?? [],
    };
    const imported =
      next.blockedNotified.length + next.duplicateDueNotified.length;

    if (imported === 0) {
      return 0;
    }

    await this.save(next);

    try {
      renameSync(filePath, `${filePath}.migrated`);
    } catch {
      // State is already in MongoDB; leftover file is harmless.
    }

    return imported;
  }
}
