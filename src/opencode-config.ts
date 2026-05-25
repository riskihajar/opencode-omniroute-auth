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

/**
 * Resolve the OpenCode server config path. Prefers an existing `opencode.jsonc`
 * over `opencode.json` so users keeping their config in JSONC are not switched
 * to plain JSON. Falls back to `opencode.json` when neither exists.
 */
export function getOpencodeConfigFilePath(): string {
  return resolveConfigFilePath(getOpencodeConfigDir(), 'opencode');
}

/**
 * Resolve a config file path inside the OpenCode config directory by basename,
 * preferring `<base>.jsonc` over `<base>.json` when both could exist.
 */
export function resolveConfigFilePath(dir: string, base: string): string {
  const jsonc = join(dir, `${base}.jsonc`);
  if (existsSync(jsonc)) return jsonc;
  return join(dir, `${base}.json`);
}

export function readOpenCodeConfig(configPath = getOpencodeConfigFilePath()): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, 'utf8');
  if (raw.trim() === '') {
    return {};
  }

  const parsed = parseJsonc(raw, configPath);
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

/**
 * Parse JSON with JSONC tolerance: line comments (`//`), block comments
 * (`/* *\/`), and trailing commas. Comments inside string literals are
 * preserved. Strict JSON inputs parse identically to `JSON.parse`.
 */
export function parseJsonc(input: string, sourceLabel?: string): unknown {
  const stripped = stripJsoncSyntax(input);
  try {
    return JSON.parse(stripped);
  } catch (error) {
    const label = sourceLabel ? ` (${sourceLabel})` : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSONC${label}: ${message}`);
  }
}

/**
 * Returns true if the source text contains JSONC-only syntax (comments or
 * trailing commas). Useful for warning users that re-serialization will not
 * preserve those constructs.
 */
export function hasJsoncOnlySyntax(input: string): boolean {
  const stripped = stripJsoncSyntax(input);
  return stripped.length !== input.length;
}

function stripJsoncSyntax(input: string): string {
  // Single pass: walk characters, copy as-is, skip comments outside string
  // literals. Track string boundaries with backslash-escape awareness.
  const n = input.length;
  let out = '';
  let i = 0;

  while (i < n) {
    const ch = input[i];
    const next = i + 1 < n ? input[i + 1] : '';

    if (ch === '"') {
      const start = i;
      i++;
      while (i < n) {
        const c = input[i];
        if (c === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (c === '"') {
          i++;
          break;
        }
        i++;
      }
      out += input.slice(start, i);
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      continue;
    }

    out += ch;
    i++;
  }

  // Strip trailing commas before `]` or `}`.
  return out.replace(/,(\s*[\]}])/g, '$1');
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
