import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type ServerOptions } from "vite";

type PipelinePorts = {
  ORCHESTRATOR_PORT: number;
  DEPLOYER_PORT: number;
  PIPELINE_UI_PORT: number;
};

function loadPipelinePorts(): PipelinePorts | null {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "../pipeline/ports.env",
  );

  if (!existsSync(path)) {
    return null;
  }

  const raw: Record<string, string> = {};

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, "").trim();

    if (!trimmed) {
      continue;
    }

    const eq = trimmed.indexOf("=");

    if (eq <= 0) {
      continue;
    }

    raw[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }

  const keys = [
    "ORCHESTRATOR_PORT",
    "DEPLOYER_PORT",
    "PIPELINE_UI_PORT",
  ] as const;
  const ports = {} as PipelinePorts;

  for (const key of keys) {
    const value = Number(raw[key]);

    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${path}: missing or invalid ${key}`);
    }

    ports[key] = value;
  }

  return ports;
}

function devServer(ports: PipelinePorts | null): ServerOptions | undefined {
  if (!ports) {
    return undefined;
  }

  const orchestrator = `http://127.0.0.1:${ports.ORCHESTRATOR_PORT}`;

  return {
    port: ports.PIPELINE_UI_PORT,
    host: "127.0.0.1",
    proxy: {
      "/api/deploys": `http://127.0.0.1:${ports.DEPLOYER_PORT}`,
      "/api": orchestrator,
      "/health": orchestrator,
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: devServer(loadPipelinePorts()),
});
