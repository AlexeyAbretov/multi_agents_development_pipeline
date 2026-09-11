import Fastify from "fastify";

import { Config } from "@config";
import { registerApiRoutes } from "@routes";

import { JobStore } from "./jobs";
import { startPoller } from "./poller";
import { startSchedulePoller } from "./schedule";

const config = Config.loadConfig();
const store = new JobStore(config.DATA_DIR);

const app = Fastify({
  logger: {
    level: "info",
  },
});

app.get("/health", async () => ({
  status: "ok",
  service: "orchestrator",
  scheduleIntervalMs: config.SCHEDULE_INTERVAL_MS,
}));

registerApiRoutes(app, config, store);

const dropped = await store.dropUnfinishedJobs();

if (dropped > 0) {
  app.log.info({ dropped }, "dropped unfinished pipeline jobs after restart");
}

const poller = startPoller(config, app.log, store);
const schedule = startSchedulePoller(config, app.log);

const shutdown = async (): Promise<void> => {
  poller.stop();
  schedule.stop();
  await app.close();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });
