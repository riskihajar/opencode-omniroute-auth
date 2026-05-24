#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getOpencodeConfigDir, getOpencodeConfigFilePath } from './src/opencode-config.js';

const SERVER_PLUGIN = '@riskihajar/opencode-omniroute-auth';
const TUI_PLUGIN = '@riskihajar/opencode-omniroute-auth/tui';
const TUI_SCHEMA = 'https://opencode.ai/tui.json';

type InstallResult = {
  path: string;
  changed: boolean;
  plugin: string;
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
  const changed = addUnique(plugins, pluginName);
  if (changed) {
    writeJsonObject(configPath, config);
  }

  return {
    path: configPath,
    changed,
    plugin: pluginName,
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
    plugin: pluginName,
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

function addUnique(values: string[], value: string): boolean {
  if (values.includes(value)) {
    return false;
  }

  values.push(value);
  return true;
}

function printResult(result: InstallResult): void {
  const status = result.changed ? 'added' : 'already present';
  console.log(`${status}: ${result.plugin}`);
  console.log(`  ${result.path}`);
}

function printHelp(): void {
  console.log('Usage: opencode-omniroute-auth install');
  console.log('');
  console.log('Adds OmniRoute server and TUI plugins to OpenCode config files.');
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
