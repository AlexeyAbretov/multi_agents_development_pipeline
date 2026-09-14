#!/usr/bin/env node

/**
 * Git launcher that drops Cursor Source Control's
 * GIT_CONFIG core.hooksPath=/dev/null override so pre-commit runs.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

function isNullDevice(value) {
  if (!value) {
    return false;
  }

  const n = value.trim().toLowerCase().replace(/\//g, '\\');

  return (
    value.trim() === '/dev/null' ||
    n === 'nul' ||
    n === '\\\\.\\nul' ||
    n.endsWith('\\nul')
  );
}

function stripNullDeviceOverrides(env) {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);

  if (!count) {
    return env;
  }

  const kept = [];

  for (let i = 0; i < count; i += 1) {
    const key = env[`GIT_CONFIG_KEY_${i}`];
    const val = env[`GIT_CONFIG_VALUE_${i}`];
    const interesting =
      /^core\.hooksPath$/i.test(key ?? '') ||
      /^core\.attributesFile$/i.test(key ?? '');

    if (interesting && isNullDevice(val)) {
      continue;
    }

    kept.push([key, val]);
  }

  const next = { ...env };

  for (let i = 0; i < count; i += 1) {
    delete next[`GIT_CONFIG_KEY_${i}`];
    delete next[`GIT_CONFIG_VALUE_${i}`];
  }

  next.GIT_CONFIG_COUNT = String(kept.length);
  kept.forEach(([key, val], i) => {
    next[`GIT_CONFIG_KEY_${i}`] = key;
    next[`GIT_CONFIG_VALUE_${i}`] = val;
  });

  return next;
}

function findGit() {
  if (process.env.PIPELINE_REAL_GIT && existsSync(process.env.PIPELINE_REAL_GIT)) {
    return process.env.PIPELINE_REAL_GIT;
  }

  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  const dirs = (process.env.PATH ?? '').split(delimiter);

  for (const dir of dirs) {
    if (!dir) {
      continue;
    }

    const candidate = `${dir.replace(/[/\\]$/, '')}/${name}`;

    if (!existsSync(candidate)) {
      continue;
    }

    if (/git-with-hooks/i.test(candidate)) {
      continue;
    }

    return candidate;
  }

  return name;
}

const result = spawnSync(findGit(), process.argv.slice(2), {
  env: stripNullDeviceOverrides(process.env),
  stdio: 'inherit',
  windowsHide: true,
});

process.exit(result.status ?? 1);
