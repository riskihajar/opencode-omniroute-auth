#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OMNIROUTE_ENDPOINTS, OMNIROUTE_PROVIDER_ID } from './src/constants.js';
import { getOpencodeConfigDir, getOpencodeConfigFilePath } from './src/opencode-config.js';

const SERVER_PLUGIN = '@riskihajar/opencode-omniroute-auth';
// Legacy subpath spec. OpenCode TUI loader 1.15.x runs `npm install <spec>`
// on this string, and npm rejects subpath specs (`@scope/pkg/sub`) with
// ENOENT because it treats the slash as a local path. We migrate any such
// entry to an absolute path that OpenCode can load directly.
const LEGACY_TUI_SPEC = '@riskihajar/opencode-omniroute-auth/tui';
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
  const tuiPath = resolveTuiPluginPath();
  const tui = installTuiPluginEntry(getTuiConfigFilePath(), tuiPath);

  printResult(server);
  printResult(tui);
}

function resolveTuiPluginPath(): string {
  // install.js sits at <pkg>/dist/install.js, tui.js at <pkg>/dist/tui.js.
  const installFile = fileURLToPath(import.meta.url);
  const tuiPath = join(dirname(installFile), 'tui.js');

  if (!existsSync(tuiPath)) {
    throw new Error(
      `Could not locate TUI plugin entry at ${tuiPath}. ` +
        'Ensure @riskihajar/opencode-omniroute-auth is installed correctly.',
    );
  }

  const normalized = tuiPath.replace(/\\/g, '/');
  if (normalized.includes('/_npx/') || normalized.includes('/_cacache/')) {
    console.warn(
      'opencode-omniroute-auth: warning - installer is running from an npx ' +
        'cache. The path written to tui.json will break when the cache is ' +
        'purged. Install globally first: ' +
        'npm install -g @riskihajar/opencode-omniroute-auth',
    );
  }

  return tuiPath;
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

function installTuiPluginEntry(configPath: string, tuiPath: string): InstallResult {
  const config = readJsonObject(configPath);
  let changed = false;

  if (config.$schema === undefined) {
    config.$schema = TUI_SCHEMA;
    changed = true;
  }

  const plugins = getOrCreatePluginArray(config, configPath);

  // Drop any legacy or stale entries pointing at this package's TUI plugin.
  // Covers: legacy subpath spec, and absolute paths from prior installs at
  // a different location (e.g. older global prefix or npx cache).
  const before = plugins.length;
  for (let i = plugins.length - 1; i >= 0; i--) {
    if (isStaleOmniRouteTuiEntry(plugins[i], tuiPath)) {
      plugins.splice(i, 1);
    }
  }
  if (plugins.length !== before) {
    changed = true;
  }

  if (addUnique(plugins, tuiPath)) {
    changed = true;
  }

  if (changed) {
    writeJsonObject(configPath, config);
  }

  return {
    path: configPath,
    changed,
    label: tuiPath,
  };
}

function isStaleOmniRouteTuiEntry(entry: string, currentAbsolutePath: string): boolean {
  if (entry === currentAbsolutePath) {
    return false;
  }
  if (entry === LEGACY_TUI_SPEC) {
    return true;
  }
  const normalized = entry.replace(/\\/g, '/');
  return (
    normalized.includes('opencode-omniroute-auth') &&
    normalized.endsWith('/dist/tui.js')
  );
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
