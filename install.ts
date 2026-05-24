#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { OMNIROUTE_ENDPOINTS, OMNIROUTE_PROVIDER_ID } from './src/constants.js';
import { getOpencodeConfigDir, getOpencodeConfigFilePath } from './src/opencode-config.js';

const SERVER_PLUGIN = '@riskihajar/opencode-omniroute-auth';
const TUI_PLUGIN = '@riskihajar/opencode-omniroute-auth/tui';
const TUI_SCHEMA = 'https://opencode.ai/tui.json';

type InstallResult = {
  path: string;
  changed: boolean;
  label: string;
};

function main(): void {
  const command = process.argv[2] ?? 'install';

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command !== 'install') {
    throw new Error(`Unknown command: ${command}. Use "install".`);
  }

  const server = installPluginEntry(getOpencodeConfigFilePath(), SERVER_PLUGIN);
  const tui = installTuiPluginEntry(getTuiConfigFilePath(), TUI_PLUGIN);

  printResult(server);
  printResult(tui);
}

function installPluginEntry(configPath: string, pluginName: string): InstallResult {
  const config = readJsonObject(configPath);
  const plugins = getOrCreatePluginArray(config, configPath);
  const pluginChanged = addUnique(plugins, pluginName);
  const providerChanged = ensureOmniRouteProvider(config, configPath);
  const changed = pluginChanged || providerChanged;
  if (changed) {
    writeJsonObject(configPath, config);
  }

  return {
    path: configPath,
    changed,
    label: `${pluginName} and provider.${OMNIROUTE_PROVIDER_ID}`,
  };
}

function installTuiPluginEntry(configPath: string, pluginName: string): InstallResult {
  const config = readJsonObject(configPath);
  let schemaChanged = false;
  if (config.$schema === undefined) {
    config.$schema = TUI_SCHEMA;
    schemaChanged = true;
  }

  const plugins = getOrCreatePluginArray(config, configPath);
  const pluginChanged = addUnique(plugins, pluginName);
  const changed = schemaChanged || pluginChanged;
  if (changed) {
    writeJsonObject(configPath, config);
  }

  return {
    path: configPath,
    changed,
    label: pluginName,
  };
}

function getTuiConfigFilePath(): string {
  return join(getOpencodeConfigDir(), 'tui.json');
}

function readJsonObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, 'utf8');
  if (raw.trim() === '') {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object in ${configPath}`);
  }

  return parsed;
}

function writeJsonObject(configPath: string, config: Record<string, unknown>): void {
  const configDir = getOpencodeConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function getOrCreatePluginArray(config: Record<string, unknown>, configPath: string): string[] {
  if (config.plugin === undefined) {
    config.plugin = [];
  }

  if (!Array.isArray(config.plugin) || !config.plugin.every((entry) => typeof entry === 'string')) {
    throw new Error(`Expected "plugin" to be a string array in ${configPath}`);
  }

  return config.plugin;
}

function ensureOmniRouteProvider(config: Record<string, unknown>, configPath: string): boolean {
  let changed = false;

  if (config.provider === undefined) {
    config.provider = {};
    changed = true;
  }

  if (!isRecord(config.provider)) {
    throw new Error(`Expected "provider" to be a JSON object in ${configPath}`);
  }

  const providers = config.provider;
  if (providers[OMNIROUTE_PROVIDER_ID] === undefined) {
    providers[OMNIROUTE_PROVIDER_ID] = {};
    changed = true;
  }

  if (!isRecord(providers[OMNIROUTE_PROVIDER_ID])) {
    throw new Error(
      `Expected "provider.${OMNIROUTE_PROVIDER_ID}" to be a JSON object in ${configPath}`,
    );
  }

  const provider = providers[OMNIROUTE_PROVIDER_ID];
  if (provider.options === undefined) {
    provider.options = {};
    changed = true;
  }

  if (!isRecord(provider.options)) {
    throw new Error(
      `Expected "provider.${OMNIROUTE_PROVIDER_ID}.options" to be a JSON object in ${configPath}`,
    );
  }

  const options = provider.options;
  if (options.baseURL === undefined) {
    options.baseURL = OMNIROUTE_ENDPOINTS.BASE_URL;
    changed = true;
  }

  if (options.apiMode === undefined) {
    options.apiMode = 'chat';
    changed = true;
  }

  return changed;
}

function addUnique(values: string[], value: string): boolean {
  if (values.includes(value)) {
    return false;
  }

  values.push(value);
  return true;
}

function printResult(result: InstallResult): void {
  const status = result.changed ? 'added' : 'already present';
  console.log(`${status}: ${result.label}`);
  console.log(`  ${result.path}`);
}

function printHelp(): void {
  console.log('Usage: opencode-omniroute-auth install');
  console.log('');
  console.log('Adds OmniRoute server provider and TUI plugin to OpenCode config files.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`opencode-omniroute-auth: ${message}`);
  process.exitCode = 1;
}
