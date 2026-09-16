import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { Document } from 'mongodb';

import type { MongodbClient } from '@providers';

export type DeployRecord = {
  /** GitHub release id. */
  releaseId: number;
  tag: string;
  status: 'deployed' | 'deploy-failed';
  mode: string;
  detail: string;
  at: string;
};

type DeployDocument = DeployRecord & Document;

type LegacyStoreFile = {
  deploys?: DeployRecord[];
};

const DEPLOYS_COLLECTION = 'deploys';

export class DeployStore {
  constructor(private readonly mongo: MongodbClient) {}

  private col() {
    return this.mongo.collection<DeployDocument>(DEPLOYS_COLLECTION);
  }

  private toRecord(doc: DeployDocument): DeployRecord {
    return {
      releaseId: doc.releaseId,
      tag: doc.tag,
      status: doc.status,
      mode: doc.mode,
      detail: doc.detail,
      at: doc.at,
    };
  }

  async ensureIndexes(): Promise<void> {
    await this.col().createIndex({ tag: 1 }, { unique: true });
    await this.col().createIndex(
      { releaseId: 1 },
      {
        unique: true,
        name: 'release_id',
        partialFilterExpression: { releaseId: { $gt: 0 } },
      },
    );
  }

  async list(): Promise<DeployRecord[]> {
    const docs = await this.col().find().sort({ at: 1 }).toArray();

    return docs.map((doc) => this.toRecord(doc));
  }

  async has(releaseId: number): Promise<boolean> {
    if (releaseId === 0) {
      return false;
    }

    const doc = await this.col().findOne({ releaseId });

    return doc !== null;
  }

  async hasTag(tag: string): Promise<boolean> {
    const doc = await this.col().findOne({ tag });

    return doc !== null;
  }

  async hasSuccessfulTag(tag: string): Promise<boolean> {
    const doc = await this.col().findOne({ tag, status: 'deployed' });

    return doc !== null;
  }

  async deployedIds(): Promise<Set<number>> {
    const docs = await this.col()
      .find({ releaseId: { $ne: 0 } })
      .toArray();

    return new Set(docs.map((doc) => doc.releaseId));
  }

  async record(entry: DeployRecord): Promise<void> {
    if (entry.releaseId !== 0) {
      await this.col().deleteMany({ releaseId: entry.releaseId });
    }

    await this.col().deleteMany({ tag: entry.tag });
    await this.col().insertOne(entry);
  }

  async importLegacyJson(dataDir: string): Promise<number> {
    const existing = await this.col().estimatedDocumentCount();

    if (existing > 0) {
      return 0;
    }

    const filePath = join(dataDir, 'deploys.json');
    let raw: string;

    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return 0;
    }

    const data = JSON.parse(raw) as LegacyStoreFile;
    const deploys = (data.deploys ?? []).map((item) => this.toRecord(item));

    if (deploys.length === 0) {
      return 0;
    }

    await this.col().insertMany(deploys);

    try {
      renameSync(filePath, `${filePath}.migrated`);
    } catch {
      // Deploys are already in MongoDB; leftover file is harmless.
    }

    return deploys.length;
  }
}
