import { type Collection, type Db, type Document, MongoClient } from 'mongodb';

import { mongodbDatabaseName } from './MongodbProvider.utils';

export class MongodbClient {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  constructor(private readonly uri: string) {}

  async connect(): Promise<void> {
    const client = new MongoClient(this.uri);
    const dbName = mongodbDatabaseName(this.uri);

    try {
      await client.connect();
      const db = client.db(dbName);

      await db.command({ ping: 1 });
      this.client = client;
      this.db = db;
    } catch (err) {
      await client.close().catch(() => undefined);

      const message = err instanceof Error ? err.message : String(err);

      throw new Error(`MongoDB connect failed (${this.uri}): ${message}`);
    }
  }

  collection<T extends Document>(name: string): Collection<T> {
    const db = this.db;

    if (!db) {
      throw new Error('MongoDB is not connected');
    }

    return db.collection<T>(name);
  }

  async close(): Promise<void> {
    const client = this.client;

    this.client = null;
    this.db = null;

    if (!client) {
      return;
    }

    await client.close();
  }
}
