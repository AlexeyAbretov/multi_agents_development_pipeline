import Fastify from 'fastify';

import { Config } from '@config';
import { MongodbClient } from '@providers';

import { startDeployPoller } from './deploy-poller';
import { DeployStore } from './deploy-store';
import { registerApiRoutes } from './DeployerService.routes';

const config = Config.loadConfig();
const mongo = new MongodbClient(config.MONGODB_URI);

await mongo.connect();

const store = new DeployStore(mongo);

await store.ensureIndexes();

const imported = await store.importLegacyJson(config.DATA_DIR);

const app = Fastify({
  logger: {
    level: 'info',
  },
});

if (imported > 0) {
  app.log.info({ imported }, 'imported deploys.json into MongoDB');
}

app.get('/health', async () => ({
  status: 'ok',
  service: 'deployer',
  deployMode: config.DEPLOY_MODE,
}));

registerApiRoutes(app, store);

const poller = startDeployPoller(config, app.log, store);

const shutdown = async (): Promise<void> => {
  poller.stop();
  await app.close();
  await mongo.close();
};

process.on('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });
