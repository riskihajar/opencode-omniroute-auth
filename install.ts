#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_STRIP_OPENCODE_SYSTEM_PROMPT,
  OMNIROUTE_ENDPOINTS,
  OMNIROUTE_PROVIDER_ID,
} from './src/constants.js';
import {
  getOpencodeConfigDir,
  getOpencodeConfigFilePath,
  hasJsoncOnlySyntax,
  parseJsonc,
  resolveConfigFilePath,
} from './src/opencode-config.js';

const SERVER_PLUGIN = '@riskihajar/opencode-omniroute-auth';
// Legacy subpath spec. OpenCode TUI loader 1.15.x runs `npm install <spec>`
// on this string, and npm rejects subpath specs (`@scope/pkg/sub`) with
// ENOENT because it treats the slash as a local path. We migrate any such
// entry to an absolute path that OpenCode can load directly.
const LEGACY_TUI_SPEC = '@riskihajar/opencode-omniroute-auth/tui';
const TUI_SCHEMA = 'https://opencode.ai/tui.json';
const PERSISTENT_TUI_INSTALL_DIR = 'omniroute-tui-plugin';
const SUPPORTED_API_MODES = ['chat', 'responses', 'anthropic'] as const;
type ApiMode = (typeof SUPPORTED_API_MODES)[number];

type InstallResult = {
  path: string;
  changed: boolean;
  label: string;
};

type CliArgs = {
  command: string;
  help: boolean;
  yes: boolean;
  baseUrl?: string;
  apiMode?: ApiMode;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.command !== 'install') {
    throw new Error(`Unknown command: ${args.command}. Use "install".`);
  }

  const interactive = !args.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;

  const serverConfigPath = getOpencodeConfigFilePath();
  const existingConfig = readJsonObject(serverConfigPath);
  const existingOptions = readOmniRouteOptions(existingConfig);

  const baseUrl = await resolveBaseUrl({
    explicit: args.baseUrl,
    current: typeof existingOptions.baseURL === 'string' ? existingOptions.baseURL : undefined,
    interactive,
  });

  const apiMode = await resolveApiMode({
    explicit: args.apiMode,
    current: typeof existingOptions.apiMode === 'string' ? existingOptions.apiMode : undefined,
    interactive,
  });

  if (interactive) {
    console.log('');
  }

  const server = installPluginEntry(serverConfigPath, SERVER_PLUGIN, { baseUrl, apiMode });
  const tuiPath = resolveTuiPluginPath();
  const tui = installTuiPluginEntry(getTuiConfigFilePath(), tuiPath);

  printResult(server);
  printResult(tui);
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { command: 'install', help: false, yes: false };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help' || arg === 'help') {
      result.help = true;
      continue;
    }
    if (arg === '-y' || arg === '--yes') {
      result.yes = true;
      continue;
    }

    const baseUrlInline = matchInlineFlag(arg, ['--base-url', '--baseURL']);
    if (baseUrlInline !== undefined) {
      result.baseUrl = baseUrlInline;
      continue;
    }
    if (arg === '--base-url' || arg === '--baseURL') {
      const next = argv[++i];
      if (typeof next !== 'string') {
        throw new Error(`${arg} requires a value`);
      }
      result.baseUrl = next;
      continue;
    }

    const apiModeInline = matchInlineFlag(arg, ['--api-mode', '--apiMode']);
    if (apiModeInline !== undefined) {
      result.apiMode = parseApiMode(apiModeInline);
      continue;
    }
    if (arg === '--api-mode' || arg === '--apiMode') {
      const next = argv[++i];
      if (typeof next !== 'string') {
        throw new Error(`${arg} requires a value`);
      }
      result.apiMode = parseApiMode(next);
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional[0]) {
    result.command = positional[0];
  }

  return result;
}

function matchInlineFlag(arg: string, names: string[]): string | undefined {
  for (const name of names) {
    const prefix = `${name}=`;
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

function parseApiMode(value: string): ApiMode {
  const normalized = value.trim().toLowerCase();
  if (!isApiMode(normalized)) {
    throw new Error(
      `Invalid apiMode: ${value}. Expected one of: ${SUPPORTED_API_MODES.join(', ')}.`,
    );
  }
  return normalized;
}

function isApiMode(value: string): value is ApiMode {
  return (SUPPORTED_API_MODES as readonly string[]).includes(value);
}

async function resolveBaseUrl(input: {
  explicit?: string;
  current?: string;
  interactive: boolean;
}): Promise<string> {
  if (input.explicit !== undefined) {
    const error = validateBaseUrl(input.explicit);
    if (error) {
      throw new Error(`Invalid --base-url: ${error}`);
    }
    return input.explicit;
  }

  const fallback = input.current ?? OMNIROUTE_ENDPOINTS.BASE_URL;

  if (!input.interactive) {
    if (input.current === undefined) {
      console.log(`Using default OmniRoute base URL: ${fallback}`);
      console.log('  (run interactively or pass --base-url=<url> to change)');
    }
    return fallback;
  }

  console.log('OmniRoute setup');
  console.log('  Press Enter to accept the default in [brackets].');
  return promptWithValidation({
    label: 'OmniRoute base URL',
    defaultValue: fallback,
    validate: validateBaseUrl,
  });
}

async function resolveApiMode(input: {
  explicit?: ApiMode;
  current?: string;
  interactive: boolean;
}): Promise<ApiMode> {
  if (input.explicit !== undefined) {
    return input.explicit;
  }

  const currentMode = isApiMode(input.current ?? '') ? (input.current as ApiMode) : undefined;
  const fallback: ApiMode = currentMode ?? 'chat';

  if (!input.interactive) {
    return fallback;
  }

  return promptWithValidation({
    label: `API mode (${SUPPORTED_API_MODES.join(' / ')})`,
    defaultValue: fallback,
    validate: (value) =>
      isApiMode(value.trim().toLowerCase())
        ? undefined
        : `must be one of: ${SUPPORTED_API_MODES.join(', ')}`,
    transform: (value) => value.trim().toLowerCase(),
  }) as Promise<ApiMode>;
}

async function promptWithValidation(input: {
  label: string;
  defaultValue: string;
  validate: (value: string) => string | undefined;
  transform?: (value: string) => string;
}): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      const raw = (await rl.question(`  ${input.label} [${input.defaultValue}]: `)).trim();
      const candidate = raw === '' ? input.defaultValue : raw;
      const finalValue = input.transform ? input.transform(candidate) : candidate;
      const error = input.validate(finalValue);
      if (!error) {
        return finalValue;
      }
      console.log(`    invalid: ${error}`);
    }
  } finally {
    rl.close();
  }
}

function validateBaseUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'not a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'protocol must be http:// or https://';
  }
  return undefined;
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
    return installPersistentTuiPackage();
  }

  return tuiPath;
}

function installPersistentTuiPackage(): string {
  const version = getPackageVersion();
  const installDir = join(getOpencodeConfigDir(), PERSISTENT_TUI_INSTALL_DIR);
  const packageSpec = `${SERVER_PLUGIN}@${version}`;

  mkdirSync(installDir, { recursive: true });
  console.log(`Installing persistent OmniRoute TUI plugin: ${packageSpec}`);
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      installDir,
      '--no-save',
      '--omit=dev',
      '--silent',
      packageSpec,
    ],
    {
      stdio: 'inherit',
    },
  );

  const tuiPath = join(
    installDir,
    'node_modules',
    '@riskihajar',
    'opencode-omniroute-auth',
    'dist',
    'tui.js',
  );

  if (!existsSync(tuiPath)) {
    throw new Error(`Persistent TUI plugin install did not create ${tuiPath}`);
  }

  return tuiPath;
}

function getPackageVersion(): string {
  const installFile = fileURLToPath(import.meta.url);
  const packageJsonPath = join(dirname(installFile), '..', 'package.json');
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
  if (!isRecord(parsed) || typeof parsed.version !== 'string') {
    throw new Error(`Could not read package version from ${packageJsonPath}`);
  }
  return parsed.version;
}

function installPluginEntry(
  configPath: string,
  pluginName: string,
  options: { baseUrl: string; apiMode: ApiMode },
): InstallResult {
  const config = readJsonObject(configPath);
  const plugins = getOrCreatePluginArray(config, configPath);
  const pluginChanged = addUnique(plugins, pluginName);
  const providerChanged = ensureOmniRouteProvider(config, configPath, options);
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
  // a different location (e.g. older global prefix, npx cache, or persistent install).
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
  return resolveConfigFilePath(getOpencodeConfigDir(), 'tui');
}

const warnedJsoncFiles = new Set<string>();

function readJsonObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, 'utf8');
  if (raw.trim() === '') {
    return {};
  }

  if (
    configPath.endsWith('.jsonc') &&
    hasJsoncOnlySyntax(raw) &&
    !warnedJsoncFiles.has(configPath)
  ) {
    warnedJsoncFiles.add(configPath);
    console.warn(
      `opencode-omniroute-auth: warning - ${configPath} contains comments or ` +
        'trailing commas; the installer will rewrite the file as plain JSON ' +
        '(comments will be lost).',
    );
  }

  const parsed = parseJsonc(raw, configPath);
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

function readOmniRouteOptions(config: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(config.provider)) return {};
  const provider = config.provider[OMNIROUTE_PROVIDER_ID];
  if (!isRecord(provider) || !isRecord(provider.options)) return {};
  return provider.options;
}

function ensureOmniRouteProvider(
  config: Record<string, unknown>,
  configPath: string,
  desired: { baseUrl: string; apiMode: ApiMode },
): boolean {
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
  if (options.baseURL !== desired.baseUrl) {
    options.baseURL = desired.baseUrl;
    changed = true;
  }

  if (options.apiMode !== desired.apiMode) {
    options.apiMode = desired.apiMode;
    changed = true;
  }

  if (options.stripOpenCodeSystemPrompt === undefined) {
    options.stripOpenCodeSystemPrompt = DEFAULT_STRIP_OPENCODE_SYSTEM_PROMPT;
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
  const status = result.changed ? 'updated' : 'already present';
  console.log(`${status}: ${result.label}`);
  console.log(`  ${result.path}`);
}

function printHelp(): void {
  console.log('Usage: opencode-omniroute-auth install [options]');
  console.log('');
  console.log('Adds OmniRoute server provider and TUI plugin to OpenCode config files.');
  console.log('Prompts for the OmniRoute base URL when run on a TTY.');
  console.log('');
  console.log('Options:');
  console.log('  --base-url <url>     Set OmniRoute base URL non-interactively');
  console.log('  --api-mode <mode>    Set OmniRoute apiMode (chat, responses, anthropic)');
  console.log('  -y, --yes            Skip prompts and use existing values or defaults');
  console.log('  -h, --help           Show this help');
  console.log('');
  console.log('Defaults are taken from your existing opencode.json when present,');
  console.log(
    `otherwise: ${OMNIROUTE_ENDPOINTS.BASE_URL} (chat, strip OpenCode prompt enabled).`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`opencode-omniroute-auth: ${message}`);
  process.exitCode = 1;
});
