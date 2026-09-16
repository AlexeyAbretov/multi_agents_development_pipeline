import { randomUUID } from "node:crypto";

export function matches(doc, filter) {
  if (!filter) {
    return true;
  }

  for (const [key, value] of Object.entries(filter)) {
    const current = doc[key];

    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$ne" in value && current === value.$ne) {
        return false;
      }

      if ("$in" in value && !value.$in.includes(current)) {
        return false;
      }

      if (!("$ne" in value) && !("$in" in value) && current !== value) {
        return false;
      }

      continue;
    }

    if (current !== value) {
      return false;
    }
  }

  return true;
}

export class MemoryCollection {
  constructor() {
    this.docs = [];
  }

  async createIndex() {
    return "ok";
  }

  async estimatedDocumentCount() {
    return this.docs.length;
  }

  async insertOne(doc) {
    const next = { ...doc };

    if (
      next.id != null &&
      this.docs.some((item) => item.id === next.id)
    ) {
      throw { code: 11000 };
    }

    if (
      next.issue != null &&
      next.role != null &&
      next.cleared !== true &&
      this.docs.some(
        (item) =>
          item.issue === next.issue &&
          item.role === next.role &&
          item.cleared !== true,
      )
    ) {
      throw { code: 11000 };
    }

    this.docs.push(next);

    return { insertedId: next.id ?? next._id ?? randomUUID() };
  }

  async insertMany(docs) {
    for (const doc of docs) {
      await this.insertOne(doc);
    }

    return { insertedCount: docs.length };
  }

  async findOne(filter, options = {}) {
    const found = this.docs.filter((doc) => matches(doc, filter));
    const sort = options.sort;

    if (sort) {
      const [key, dir] = Object.entries(sort)[0];

      found.sort(
        (a, b) => String(a[key]).localeCompare(String(b[key])) * dir,
      );
    }

    return found[0] ? { ...found[0] } : null;
  }

  find(filter = {}) {
    const col = this;

    return {
      sort() {
        return this;
      },
      async toArray() {
        return col.docs.filter((doc) => matches(doc, filter)).map((doc) => {
          return { ...doc };
        });
      },
    };
  }

  async updateMany(filter, update) {
    const set = update.$set ?? {};
    let modifiedCount = 0;

    for (const doc of this.docs) {
      if (!matches(doc, filter)) {
        continue;
      }

      Object.assign(doc, set);
      modifiedCount += 1;
    }

    return { modifiedCount };
  }

  async updateOne(filter, update, options = {}) {
    const set = update.$set ?? {};
    const index = this.docs.findIndex((doc) => matches(doc, filter));

    if (index >= 0) {
      Object.assign(this.docs[index], set);

      return { modifiedCount: 1, upsertedCount: 0 };
    }

    if (options.upsert) {
      this.docs.push({ ...filter, ...set });

      return { modifiedCount: 0, upsertedCount: 1 };
    }

    return { modifiedCount: 0, upsertedCount: 0 };
  }

  async replaceOne(filter, replacement) {
    const index = this.docs.findIndex((doc) => matches(doc, filter));

    if (index < 0) {
      return { modifiedCount: 0 };
    }

    this.docs[index] = { ...replacement, _id: this.docs[index]._id };

    return { modifiedCount: 1 };
  }

  async deleteMany(filter) {
    const before = this.docs.length;

    this.docs = this.docs.filter((doc) => !matches(doc, filter));

    return { deletedCount: before - this.docs.length };
  }
}

export class MemoryMongo {
  constructor() {
    this.cols = new Map();
  }

  collection(name) {
    const existing = this.cols.get(name);

    if (existing) {
      return existing;
    }

    const created = new MemoryCollection();

    this.cols.set(name, created);

    return created;
  }
}
