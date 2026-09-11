import Fastify from "fastify";

import { Config } from "@config";

import { startDeployPoller } from "../../deploy-poller";
import { DeployStore } from "../../deploy-store";

const config = Config.loadConfig();
const store = new DeployStore(config.DATA_DIR);

const app = Fastify({
  logger: {
    level: "info",
  },
});

app.get("/health", async () => ({
  status: "ok",
  service: "deployer",
  deployMode: config.DEPLOY_MODE,
}));

const poller = startDeployPoller(config, app.log, store);

const shutdown = async (): Promise<void> => {
  poller.stop();
  await app.close();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });
