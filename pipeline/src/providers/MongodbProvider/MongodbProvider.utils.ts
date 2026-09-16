import { MONGODB_DUPLICATE_KEY } from './MongodbProvider.constants';

export function mongodbDatabaseName(uri: string): string {
  let pathname: string;

  try {
    pathname = new URL(uri).pathname.replace(/^\/+/u, '');
  } catch {
    throw new Error(`Invalid MONGODB_URI: ${uri}`);
  }

  const name = pathname.split('/')[0]?.trim();

  if (!name) {
    throw new Error(`MONGODB_URI must include a database name: ${uri}`);
  }

  return name;
}

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number })?.code === MONGODB_DUPLICATE_KEY;
}
