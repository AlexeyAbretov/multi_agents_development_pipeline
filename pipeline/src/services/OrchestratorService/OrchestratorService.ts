import Fastify from 'fastify';

import { Config } from '@config';
import { MongodbClient } from '@providers';

import { JobStore } from './jobs';
import { registerApiRoutes } from './OrchestratorService.routes';
import { startPoller } from './poller';
import { startSchedulePoller } from './schedule';
import { ScheduleStateStore } from './schedule-state';

const config = Config.loadConfig();
const mongo = new MongodbClient(config.MONGODB_URI);

await mongo.connect();

const store = new JobStore(mongo);

await store.ensureIndexes();

const imported = await store.importLegacyJson(config.DATA_DIR);
const scheduleState = new ScheduleStateStore(mongo);
const importedSchedule = await scheduleState.importLegacyJson(config.DATA_DIR);

const app = Fastify({
  logger: {
    level: 'info',
  },
});

if (imported > 0) {
  app.log.info({ imported }, 'imported jobs.json into MongoDB');
}

if (importedSchedule > 0) {
  app.log.info(
    { imported: importedSchedule },
    'imported schedule-state.json into MongoDB',
  );
}

app.get('/health', async () => ({
  status: 'ok',
  service: 'orchestrator',
  scheduleIntervalMs: config.SCHEDULE_INTERVAL_MS,
}));

registerApiRoutes(app, config, store);

const dropped = await store.dropUnfinishedJobs();

if (dropped > 0) {
  app.log.info({ dropped }, 'dropped unfinished pipeline jobs after restart');
}

const poller = startPoller(config, app.log, store);
const schedule = startSchedulePoller(config, app.log, scheduleState);

const shutdown = async (): Promise<void> => {
  poller.stop();
  schedule.stop();
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
