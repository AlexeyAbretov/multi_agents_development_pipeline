import type { FastifyInstance } from 'fastify';

import type { Config } from '@config';

import { DeployStore } from './deploy-store';

export function registerApiRoutes(app: FastifyInstance, config: Config): void {
  app.get('/api/deploys', async () => {
    const deploys = new DeployStore(config.DATA_DIR).load().deploys;

    return {
      deploys: [...deploys].sort((a, b) => b.at.localeCompare(a.at)),
    };
  });
}
