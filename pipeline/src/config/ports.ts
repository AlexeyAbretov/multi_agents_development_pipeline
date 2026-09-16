import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PipelinePorts = {
  ORCHESTRATOR_PORT: number;
  DEPLOYER_PORT: number;
  PIPELINE_UI_PORT: number;
};

const PORT_KEYS = [
  'ORCHESTRATOR_PORT',
  'DEPLOYER_PORT',
  'PIPELINE_UI_PORT',
] as const;

const PORTS_ENV_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../ports.env',
);

export function parsePortsEnv(
  text: string,
  source = 'ports.env',
): PipelinePorts {
  const raw: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim();

    if (!trimmed) {
      continue;
    }

    const eq = trimmed.indexOf('=');

    if (eq <= 0) {
      continue;
    }

    raw[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }

  const ports = {} as PipelinePorts;

  for (const key of PORT_KEYS) {
    const value = Number(raw[key]);

    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${source}: missing or invalid ${key}`);
    }

    ports[key] = value;
  }

  return ports;
}

export function loadPorts(path = PORTS_ENV_PATH): PipelinePorts {
  return parsePortsEnv(readFileSync(path, 'utf8'), path);
}

export const ports = loadPorts();
