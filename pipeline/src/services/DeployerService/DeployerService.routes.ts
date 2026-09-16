import type { FastifyInstance } from 'fastify';

import type { DeployStore } from './deploy-store';

export function registerApiRoutes(
  app: FastifyInstance,
  store: DeployStore,
): void {
  app.get('/api/deploys', async () => {
    const deploys = await store.list();

    return {
      deploys: [...deploys].sort((a, b) => b.at.localeCompare(a.at)),
    };
  });
}
