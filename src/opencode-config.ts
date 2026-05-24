import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { OMNIROUTE_PROVIDER_ID } from './constants.js';

export function getOpencodeConfigDir(): string {
  const overridden = process.env.OPENCODE_CONFIG_DIR;
  if (typeof overridden === 'string' && overridden.trim() !== '') {
    return overridden.trim();
  }

  return join(homedir(), '.config', 'opencode');
}

export function getOpencodeConfigFilePath(): string {
  return join(getOpencodeConfigDir(), 'opencode.json');
}

export function readOpenCodeConfig(configPath = getOpencodeConfigFilePath()): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, 'utf8');
  if (raw.trim() === '') {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Expected OpenCode config to be a JSON object: ${configPath}`);
  }

  return parsed;
}

export function writeOpenCodeConfig(
  config: Record<string, unknown>,
  configPath = getOpencodeConfigFilePath(),
): void {
  const dir = getOpencodeConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function getStripOpenCodeSystemPromptStatus(): boolean {
  return getConfiguredStripOpenCodeSystemPromptStatus() === true;
}

export function getConfiguredStripOpenCodeSystemPromptStatus(): boolean | undefined {
  const config = readOpenCodeConfig();
  const provider = getProviderConfig(config);
  const options = isRecord(provider?.options) ? provider.options : undefined;
  const value = options?.stripOpenCodeSystemPrompt;

  return typeof value === 'boolean' ? value : undefined;
}

export function setStripOpenCodeSystemPromptStatus(value: boolean): boolean {
  const config = readOpenCodeConfig();
  const provider = getOrCreateProviderConfig(config);
  const options = getOrCreateProviderOptions(provider);
  options.stripOpenCodeSystemPrompt = value;
  writeOpenCodeConfig(config);

  return value;
}

export function toggleStripOpenCodeSystemPromptStatus(): boolean {
  return setStripOpenCodeSystemPromptStatus(!getStripOpenCodeSystemPromptStatus());
}

export function getOrCreateProviderConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(config.provider)) {
    config.provider = {};
  }

  const providers = config.provider as Record<string, unknown>;
  if (!isRecord(providers[OMNIROUTE_PROVIDER_ID])) {
    providers[OMNIROUTE_PROVIDER_ID] = {};
  }

  return providers[OMNIROUTE_PROVIDER_ID] as Record<string, unknown>;
}

export function getOrCreateProviderOptions(provider: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(provider.options)) {
    provider.options = {};
  }

  return provider.options as Record<string, unknown>;
}

function getProviderConfig(config: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(config.provider)) {
    return undefined;
  }

  const provider = config.provider[OMNIROUTE_PROVIDER_ID];
  return isRecord(provider) ? provider : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
