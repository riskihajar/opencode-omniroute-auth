import { tool, type Plugin, type Hooks } from '@opencode-ai/plugin';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  OmniRouteAnthropicToolChoicePolicy,
  OmniRouteApiMode,
  OmniRouteConfig,
  OmniRouteModel,
  OmniRouteModelMetadata,
  OmniRouteModelMetadataBlock,
  OmniRouteModelMetadataConfig,
  OmniRouteModelsDevConfig,
  OmniRouteProviderModel,
} from './types.js';
import {
  DEFAULT_STRIP_OPENCODE_SYSTEM_PROMPT,
  OMNIROUTE_PROVIDER_ID,
  OMNIROUTE_DEFAULT_MODELS,
  OMNIROUTE_ENDPOINTS,
} from './constants.js';
import { fetchModels } from './models.js';
import {
  getConfiguredStripOpenCodeSystemPromptStatus,
  getOpencodeConfigFilePath,
  getStripOpenCodeSystemPromptStatus,
  setStripOpenCodeSystemPromptStatus,
  toggleStripOpenCodeSystemPromptStatus,
} from './opencode-config.js';

const OMNIROUTE_PROVIDER_NAME = 'OmniRoute';
const OMNIROUTE_CHAT_PROVIDER_NPM = '@ai-sdk/openai';
const OMNIROUTE_OPENAI_COMPATIBLE_CHAT_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const OMNIROUTE_RESPONSES_PROVIDER_NPM = '@ai-sdk/openai';
const OMNIROUTE_ANTHROPIC_PROVIDER_NPM = '@ai-sdk/anthropic';
const OMNIROUTE_ANTHROPIC_BETA_HEADER =
  'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
const DEFAULT_ANTHROPIC_TOOL_CHOICE: OmniRouteAnthropicToolChoicePolicy = 'composer-any';
const ANTHROPIC_STREAM_EVENT_TYPES = new Set([
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'ping',
  'error',
]);
const OMNIROUTE_PROVIDER_ENV = ['OMNIROUTE_API_KEY'];
const DEBUG = process.env.OMNIROUTE_PLUGIN_DEBUG === '1';

function debugLog(message: string, ...args: unknown[]): void {
  if (DEBUG) {
    console.log(message, ...args);
  }
}

type AuthHook = NonNullable<Hooks['auth']>;
type AuthLoader = NonNullable<AuthHook['loader']>;
type AuthAccessor = Parameters<AuthLoader>[0];
type ProviderDefinition = Parameters<AuthLoader>[1];
type ChatHeadersHook = NonNullable<Hooks['chat.headers']>;
type ChatParamsHook = NonNullable<Hooks['chat.params']>;

interface ChatMessageHookInput {
  model?: {
    providerID: string;
    modelID: string;
  };
}

interface ChatMessageHookOutput {
  parts: unknown[];
}

type ChatMessageHook = (
  input: ChatMessageHookInput,
  output: ChatMessageHookOutput,
) => Promise<void>;

export const OmniRouteAuthPlugin: Plugin = async (_input) => {
  return {
    config: async (config) => {
      const providers = config.provider ?? {};
      const existingProvider = providers[OMNIROUTE_PROVIDER_ID];
      const baseUrl = getBaseUrl(existingProvider?.options);
      const apiMode = getApiMode(existingProvider?.options);
      const modelCacheTtl = getPositiveNumber(existingProvider?.options, 'modelCacheTtl');
      const refreshOnList = getBoolean(existingProvider?.options, 'refreshOnList');
      const enableCombos = getBoolean(existingProvider?.options, 'enableCombos');
      const modelsDev = getModelsDevConfig(existingProvider?.options);
      const enableFullGpt55Context = getBoolean(
        existingProvider?.options,
        'enableFullGpt55Context',
      );
      const configuredModelMetadata = mergeModelMetadataConfigs(
        getModelMetadataConfig(existingProvider?.options),
        getProviderModelMetadataConfig(existingProvider?.models),
      );
      const providerNpm = resolveProviderNpm(existingProvider?.npm, apiMode);
      const providerUrl = getProviderUrl(baseUrl, apiMode);
      const providerEnv = existingProvider?.env ?? OMNIROUTE_PROVIDER_ENV;
      let configuredModels = getConfigSeedModels(existingProvider?.models);
      const providerApiKey = await getProviderApiKey(_input, providerEnv);

      if (providerApiKey) {
        try {
          configuredModels = await fetchModels(
            {
              baseUrl,
              apiKey: providerApiKey,
              apiMode,
              modelCacheTtl,
              refreshOnList,
              enableCombos,
              modelsDev,
              modelMetadata: configuredModelMetadata,
              enableFullGpt55Context,
            },
            providerApiKey,
            refreshOnList === true,
          );
        } catch (error) {
          console.warn('[OmniRoute] Failed to eagerly hydrate models during config, using seeds:', error);
        }
      }

      providers[OMNIROUTE_PROVIDER_ID] = {
        ...existingProvider,
        name: existingProvider?.name ?? OMNIROUTE_PROVIDER_NAME,
        api: providerUrl,
        npm: providerNpm,
        env: providerEnv,
        options: {
          ...(existingProvider?.options ?? {}),
          baseURL: baseUrl,
          url: providerUrl,
          apiMode,
          stripOpenCodeSystemPrompt:
            existingProvider?.options?.stripOpenCodeSystemPrompt ??
            DEFAULT_STRIP_OPENCODE_SYSTEM_PROMPT,
          modelMetadata: configuredModelMetadata,
        },
        models: toProviderModels(
          configuredModels,
          baseUrl,
          {
            baseUrl,
            apiKey: providerApiKey ?? '',
            apiMode,
            modelCacheTtl,
            refreshOnList,
            enableCombos,
            modelsDev,
            modelMetadata: configuredModelMetadata,
            enableFullGpt55Context,
          },
        ),
      };

      config.provider = providers;
    },
    tool: {
      omniroute_system_prompt: createSystemPromptToggleTool(),
    },
    auth: createAuthHook(),
    'chat.message': createChatMessageHook(),
    'chat.headers': createChatHeadersHook(),
    'chat.params': createChatParamsHook(),
  };
};

function createAuthHook(): AuthHook {
  return {
    provider: OMNIROUTE_PROVIDER_ID,
    methods: [
      {
        type: 'api',
        label: 'API Key',
      },
    ],
    loader: loadProviderOptions,
  };
}

function createSystemPromptToggleTool(): ReturnType<typeof tool> {
  return tool({
    description: 'Toggle OpenCode system prompt stripping for OmniRoute requests in opencode.json',
    args: {
      action: tool.schema.enum(['toggle', 'on', 'off', 'status']).describe(
        'Whether to toggle, enable, disable, or show the current setting.',
      ),
    },
    async execute(args): Promise<string> {
      const action = typeof args.action === 'string' ? args.action : 'status';
      const configPath = getOpencodeConfigFilePath();
      const previous = getStripOpenCodeSystemPromptStatus();

      if (action === 'status') {
        return `OpenCode system prompt stripping is ${previous ? 'enabled' : 'disabled'}.`;
      }

      const next = action === 'toggle'
        ? toggleStripOpenCodeSystemPromptStatus()
        : setStripOpenCodeSystemPromptStatus(action === 'on');

      return [
        `OpenCode system prompt stripping is now ${next ? 'enabled' : 'disabled'}.`,
        `Config updated: ${configPath}`,
        'Restart OpenCode or reload the provider config for this setting to affect new requests.',
      ].join('\n');
    },
  });
}

function createChatHeadersHook(): ChatHeadersHook {
  return (_input, output) => {
    if (_input.model.providerID !== OMNIROUTE_PROVIDER_ID) {
      return output;
    }

    return {
      headers: {
        ...output.headers,
        originator: 'opencode',
        session_id: _input.sessionID,
      },
    };
  };
}

function createChatMessageHook(): ChatMessageHook {
  return async (
    _input: ChatMessageHookInput,
    output: ChatMessageHookOutput,
  ): Promise<void> => {
    if (_input.model?.providerID !== OMNIROUTE_PROVIDER_ID) {
      return;
    }

    const rawAgentPart = output.parts.find(
      (part) => isRecord(part) && part.type === 'agent' && typeof part.name === 'string',
    );
    if (!isRecord(rawAgentPart)) {
      return;
    }
    const agentPart: Record<string, unknown> = rawAgentPart;
    if (!agentPart || typeof agentPart.name !== 'string') {
      return;
    }

    const agentName = agentPart.name;
    const prompt = getSubagentPromptFromParts(output.parts, agentName);
    delete agentPart.name;
    delete agentPart.source;
    agentPart.type = 'subtask';
    agentPart.agent = agentName;
    agentPart.description = getSubagentDescription(agentName);
    agentPart.prompt = prompt;

    for (let index = output.parts.length - 1; index >= 0; index -= 1) {
      const part = output.parts[index];
      if (
        isRecord(part) &&
        part.type === 'text' &&
        part.synthetic === true &&
        typeof part.text === 'string' &&
        OPENCODE_SUBAGENT_PROMPT_RE.test(part.text)
      ) {
        output.parts.splice(index, 1);
      }
    }

    debugLog(`[OmniRoute] Converted @${agentName} agent mention to direct subtask`);
  };
}

function getSubagentPromptFromParts(parts: unknown[], agentName: string): string {
  const text = parts
    .filter((part) => isRecord(part) && part.type === 'text' && part.synthetic !== true)
    .flatMap((part) => collectTextContent(part))
    .join('\n')
    .replace(new RegExp(`@${escapeRegExp(agentName)}\\b`, 'gi'), '')
    .trim();

  if (text) {
    return text;
  }

  return `Use the ${agentName} agent to inspect the current project and report the relevant findings.`;
}

function getSubagentDescription(agentName: string): string {
  return `${agentName} task`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createChatParamsHook(): ChatParamsHook {
  return (_input, output) => {
    if (_input.model.providerID !== OMNIROUTE_PROVIDER_ID) {
      return output;
    }

    const shouldMatchOpenAiCodexParams =
      _input.model.api.npm === OMNIROUTE_RESPONSES_PROVIDER_NPM &&
      isOpenAiCodexLikeModel(_input.model.api.id);

    if (!shouldMatchOpenAiCodexParams) {
      return output;
    }

    return {
      ...output,
      maxOutputTokens: undefined,
      options: {
        ...output.options,
        store: false,
        promptCacheKey: _input.sessionID,
      },
    };
  };
}

async function loadProviderOptions(
  getAuth: AuthAccessor,
  provider: ProviderDefinition,
): Promise<Record<string, unknown>> {
  const auth = await getAuth();
  if (!auth || auth.type !== 'api') {
    throw new Error(
      "No API key available. Please run '/connect omniroute' to set up your OmniRoute connection.",
    );
  }

  const config = createRuntimeConfig(provider, auth.key);

  let models: OmniRouteModel[] = [];
  try {
    const forceRefresh = config.refreshOnList !== false;
    models = await fetchModels(config, config.apiKey, forceRefresh);
    debugLog(`[OmniRoute] Available models: ${models.map((model) => model.id).join(', ')}`);
  } catch (error) {
    console.warn('[OmniRoute] Failed to fetch models, using defaults:', error);
    models = OMNIROUTE_DEFAULT_MODELS;
  }

  replaceProviderModels(provider, toProviderModels(models, config.baseUrl, config));
  if (isRecord(provider.models)) {
    debugLog(`[OmniRoute] Provider models hydrated: ${Object.keys(provider.models).length}`);
  }

  return {
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    url: getProviderUrl(config.baseUrl, config.apiMode),
    fetch: createFetchInterceptor(config),
  };
}

function createRuntimeConfig(provider: ProviderDefinition, apiKey: string): OmniRouteConfig {
  const baseUrl = getBaseUrl(provider.options);
  const modelCacheTtl = getPositiveNumber(provider.options, 'modelCacheTtl');
  const refreshOnList = getBoolean(provider.options, 'refreshOnList');
  const enableCombos = getBoolean(provider.options, 'enableCombos');
  const enableFullGpt55Context = getBoolean(provider.options, 'enableFullGpt55Context');
  const stripOpenCodeSystemPrompt =
    getBoolean(provider.options, 'stripOpenCodeSystemPrompt') ??
    DEFAULT_STRIP_OPENCODE_SYSTEM_PROMPT;
  const modelsDev = getModelsDevConfig(provider.options);
  const modelMetadata = getModelMetadataConfig(provider.options);

  return {
    baseUrl,
    apiKey,
    apiMode: getApiMode(provider.options),
    anthropicToolChoice: getAnthropicToolChoicePolicy(provider.options),
    modelCacheTtl,
    refreshOnList,
    enableCombos,
    enableFullGpt55Context,
    stripOpenCodeSystemPrompt,
    modelsDev,
    modelMetadata,
  };
}

function resolveProviderNpm(npm: unknown, apiMode: OmniRouteApiMode): string {
  const expected = getProviderNpm(apiMode);
  if (typeof npm !== 'string' || npm.trim() === '') {
    return expected;
  }

  if (npm !== expected) {
    console.warn(`[OmniRoute] provider.npm (${npm}) does not match apiMode (${apiMode}). Using ${expected}.`);
  }

  return expected;
}

function getApiMode(options?: Record<string, unknown>): OmniRouteApiMode {
  const value = options?.apiMode;
  if (value === undefined) {
    return 'chat';
  }

  if (isApiMode(value)) {
    return value;
  }

  console.warn(`[OmniRoute] Unsupported apiMode option: ${String(value)}. Using chat.`);
  return 'chat';
}

function getAnthropicToolChoicePolicy(
  options?: Record<string, unknown>,
): OmniRouteAnthropicToolChoicePolicy {
  const value = options?.anthropicToolChoice;
  if (value === undefined) {
    return DEFAULT_ANTHROPIC_TOOL_CHOICE;
  }

  if (value === 'auto' || value === 'composer-any' || value === 'any') {
    return value;
  }

  console.warn(
    `[OmniRoute] Unsupported anthropicToolChoice option: ${String(value)}. ` +
      `Using ${DEFAULT_ANTHROPIC_TOOL_CHOICE}.`,
  );
  return DEFAULT_ANTHROPIC_TOOL_CHOICE;
}

function getProviderApiKeyFromEnv(env: string[] | undefined): string | undefined {
  for (const name of env ?? []) {
    const value = process.env[name];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

async function getProviderApiKey(
  _input: Parameters<Plugin>[0],
  env: string[] | undefined,
): Promise<string | undefined> {
  const stored = await getProviderApiKeyFromLocalAuth();
  if (stored) {
    return stored;
  }

  return getProviderApiKeyFromEnv(env);
}

async function getProviderApiKeyFromLocalAuth(): Promise<string | undefined> {
  try {
    const raw = await readFile(getOpencodeAuthFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const provider = parsed[OMNIROUTE_PROVIDER_ID];
    if (!isRecord(provider) || provider.type !== 'api') {
      return undefined;
    }

    const key = provider.key;
    return typeof key === 'string' && key.trim() !== '' ? key.trim() : undefined;
  } catch (error) {
    debugLog('[OmniRoute] Failed to read local provider auth during config bootstrap:', error);
    return undefined;
  }
}

function getOpencodeAuthFilePath(): string {
  const overridden = process.env.OPENCODE_AUTH_PATH;
  if (typeof overridden === 'string' && overridden.trim() !== '') {
    return overridden.trim();
  }

  const dataHome = process.env.XDG_DATA_HOME;
  if (typeof dataHome === 'string' && dataHome.trim() !== '') {
    return join(dataHome, 'opencode', 'auth.json');
  }

  return join(homedir(), '.local', 'share', 'opencode', 'auth.json');
}

function isApiMode(value: unknown): value is OmniRouteApiMode {
  return value === 'chat' || value === 'responses' || value === 'anthropic';
}

function getProviderNpm(apiMode: OmniRouteApiMode, model?: OmniRouteModel): string {
  if (apiMode === 'anthropic') {
    return OMNIROUTE_ANTHROPIC_PROVIDER_NPM;
  }

  if (apiMode === 'chat' && usesOpenAiCompatibleChatRuntime(model?.owned_by)) {
    return OMNIROUTE_OPENAI_COMPATIBLE_CHAT_PROVIDER_NPM;
  }

  return apiMode === 'responses'
    ? OMNIROUTE_RESPONSES_PROVIDER_NPM
    : OMNIROUTE_CHAT_PROVIDER_NPM;
}

function getEffectiveApiModeForModel(
  model: OmniRouteModel,
  requestedApiMode: OmniRouteApiMode,
): OmniRouteApiMode {
  if (model.apiMode) {
    return model.apiMode;
  }

  if (usesAnthropicMessagesRuntime(model.id, model.root, model.owned_by)) {
    return 'anthropic';
  }

  if (usesOpenAiCompatibleChatRuntime(model.owned_by)) {
    return 'chat';
  }

  if (requestedApiMode !== 'responses') {
    return requestedApiMode;
  }

  return supportsResponsesApiStreaming(model.id) ? 'responses' : 'chat';
}

function isAnthropicFamilyModel(modelId: string, root?: string, ownedBy?: string): boolean {
  const candidates = [modelId, root, ownedBy]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => stripModelRuntimeSuffixes(value.toLowerCase()));

  return candidates.some(
    (value) =>
      value.includes('anthropic') ||
      value.includes('claude') ||
      value.includes('opus') ||
      value.includes('sonnet') ||
      value.includes('haiku'),
  );
}

function usesAnthropicMessagesRuntime(modelId: string, root?: string, ownedBy?: string): boolean {
  return isAnthropicFamilyModel(modelId, root, ownedBy) || isCursorComposerModel(modelId, root);
}

function usesOpenAiCompatibleChatRuntime(ownedBy?: string): boolean {
  return typeof ownedBy === 'string' && ownedBy.toLowerCase().startsWith('openai-compatible-chat');
}

function isCursorComposerModel(modelId: string, root?: string): boolean {
  const candidates = [modelId, root]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => stripModelRuntimeSuffixes(value.toLowerCase()));

  return candidates.some(
    (value) =>
      value === 'cu/composer-2.5' ||
      value === 'cursor/composer-2.5' ||
      value.endsWith('/composer-2.5'),
  );
}

function supportsResponsesApiStreaming(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const baseModelId = stripModelRuntimeSuffixes(id);

  if (baseModelId === 'cu/default' || baseModelId === 'cursor/default') {
    return false;
  }

  if (
    baseModelId.includes('mlx/') ||
    baseModelId.includes('/mlx-') ||
    baseModelId.includes('mlx-community/') ||
    baseModelId.includes('qwen') ||
    baseModelId.includes('claude') ||
    baseModelId.includes('anthropic') ||
    baseModelId.includes('opus') ||
    baseModelId.includes('sonnet') ||
    baseModelId.includes('haiku') ||
    baseModelId.includes('gemini') ||
    isCursorComposerModel(baseModelId)
  ) {
    return false;
  }

  return true;
}

function stripModelRuntimeSuffixes(modelId: string): string {
  return modelId
    .replace(/-(thinking|reasoning)$/i, '')
    .replace(/-(minimal|low|medium|high|max|xhigh|none)$/i, '');
}

function getProviderUrl(baseUrl: string, apiMode: OmniRouteApiMode): string {
  return baseUrl;
}

function getBaseUrl(options?: Record<string, unknown>): string {
  const rawBaseUrl = options?.baseURL;
  if (typeof rawBaseUrl !== 'string') {
    return OMNIROUTE_ENDPOINTS.BASE_URL;
  }

  const trimmed = rawBaseUrl.trim();
  if (trimmed === '') {
    return OMNIROUTE_ENDPOINTS.BASE_URL;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(`[OmniRoute] Ignoring unsupported baseURL protocol: ${parsed.protocol}`);
      return OMNIROUTE_ENDPOINTS.BASE_URL;
    }

    return trimmed;
  } catch {
    console.warn(`[OmniRoute] Ignoring invalid baseURL: ${trimmed}`);
    return OMNIROUTE_ENDPOINTS.BASE_URL;
  }
}

function getPositiveNumber(
  options: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = options?.[key];
  if (typeof value === 'number' && value > 0) {
    return value;
  }
  return undefined;
}

function getBoolean(
  options: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = options?.[key];
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function getModelsDevConfig(options: Record<string, unknown> | undefined): OmniRouteModelsDevConfig | undefined {
  const raw = options?.modelsDev;
  if (!isRecord(raw)) return undefined;

  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined;
  const url = typeof raw.url === 'string' && raw.url.trim() !== '' ? raw.url.trim() : undefined;
  const cacheTtl = getPositiveNumber(raw, 'cacheTtl');
  const timeoutMs = getPositiveNumber(raw, 'timeoutMs');
  const providerAliases = getStringRecord(raw.providerAliases);

  if (
    enabled === undefined &&
    url === undefined &&
    cacheTtl === undefined &&
    timeoutMs === undefined &&
    providerAliases === undefined
  ) {
    return undefined;
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(cacheTtl !== undefined ? { cacheTtl } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(providerAliases !== undefined ? { providerAliases } : {}),
  };
}

function getModelMetadataConfig(
  options: Record<string, unknown> | undefined,
): OmniRouteModelMetadataConfig | undefined {
  const raw = options?.modelMetadata;
  if (!raw) return undefined;

  if (Array.isArray(raw)) {
    const filtered = raw.filter(
      (item) =>
        isRecord(item) && (typeof item.match === 'string' || coerceRegExp(item.match) !== null),
    );
    return filtered.length > 0 ? (filtered as unknown as OmniRouteModelMetadataConfig) : undefined;
  }

  if (isRecord(raw)) {
    const hasAny = Object.values(raw).some((value) => isRecord(value));
    return hasAny ? (raw as unknown as OmniRouteModelMetadataConfig) : undefined;
  }

  return undefined;
}

function getProviderModelMetadataConfig(
  models: unknown,
): OmniRouteModelMetadataConfig | undefined {
  if (!isRecord(models)) return undefined;

  const metadata: Record<string, OmniRouteModelMetadata> = {};

  for (const [modelId, raw] of Object.entries(models)) {
    if (!isRecord(raw)) continue;

    const next: OmniRouteModelMetadata = {};

    if (typeof raw.name === 'string' && raw.name.trim() !== '') {
      next.name = raw.name;
    }

    if (typeof raw.description === 'string' && raw.description.trim() !== '') {
      next.description = raw.description;
    }

    if (isRecord(raw.limit)) {
      const context = raw.limit.context;
      const input = raw.limit.input;
      const output = raw.limit.output;
      if (typeof context === 'number' && context > 0) next.contextWindow = context;
      if (typeof input === 'number' && input > 0) next.maxInputTokens = input;
      if (typeof output === 'number' && output > 0) next.maxTokens = output;
    }

    if (isRecord(raw.capabilities)) {
      if (typeof raw.capabilities.reasoning === 'boolean') {
        next.reasoning = raw.capabilities.reasoning;
      }
      if (typeof raw.capabilities.toolcall === 'boolean') {
        next.supportsTools = raw.capabilities.toolcall;
      }
      if (typeof raw.capabilities.attachment === 'boolean') {
        next.supportsVision = raw.capabilities.attachment;
      }
    }

    if (isRecord(raw.variants) && Object.keys(raw.variants).length > 0) {
      next.variants = raw.variants;
    }

    if (raw.resetEmbeddedReasoningVariant === true) {
      next.resetEmbeddedReasoningVariant = true;
    }

    if (isApiMode(raw.api)) {
      next.apiMode = raw.api;
    }

    if (isApiMode(raw.apiMode)) {
      next.apiMode = raw.apiMode;
    }

    if (Object.keys(next).length > 0) {
      metadata[modelId] = next;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function mergeModelMetadataConfigs(
  base: OmniRouteModelMetadataConfig | undefined,
  extra: OmniRouteModelMetadataConfig | undefined,
): OmniRouteModelMetadataConfig | undefined {
  if (!base) return extra;
  if (!extra) return base;

  if (Array.isArray(base) && Array.isArray(extra)) {
    return [...base, ...extra];
  }

  if (!Array.isArray(base) && !Array.isArray(extra)) {
    const merged: Record<string, OmniRouteModelMetadata> = { ...base };
    for (const [modelId, metadata] of Object.entries(extra)) {
      merged[modelId] = merged[modelId]
        ? { ...merged[modelId], ...metadata }
        : metadata;
    }
    return merged;
  }

  const toBlocks = (value: OmniRouteModelMetadataConfig): OmniRouteModelMetadataBlock[] => {
    if (Array.isArray(value)) {
      return value as OmniRouteModelMetadataBlock[];
    }

    return Object.entries(value).map(([match, metadata]) => ({
      match,
      addIfMissing: true,
      ...metadata,
    }));
  };

  return [...toBlocks(base), ...toBlocks(extra)];
}

function getStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;

  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    out[key] = trimmed;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function isRegExp(value: unknown): value is RegExp {
  return Object.prototype.toString.call(value) === '[object RegExp]';
}

function coerceRegExp(value: unknown): RegExp | null {
  if (isRegExp(value)) return value;
  if (!isRecord(value)) return null;

  const source = value.source;
  const flags = value.flags;
  if (typeof source !== 'string' || typeof flags !== 'string') return null;

  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function replaceProviderModels(
  provider: ProviderDefinition,
  models: Record<string, OmniRouteProviderModel>,
): void {
  if (isRecord(provider.models)) {
    for (const key of Object.keys(provider.models)) {
      delete provider.models[key];
    }
    Object.assign(provider.models, models);
    return;
  }

  provider.models = models;
}

function getConfigSeedModels(models: unknown): OmniRouteModel[] {
  if (!isRecord(models) || Object.keys(models).length === 0) {
    return OMNIROUTE_DEFAULT_MODELS;
  }

  return Object.entries(models).map(([modelId, raw]) => {
    const metadata = isRecord(raw) ? raw : {};
    const limit = isRecord(metadata.limit) ? metadata.limit : undefined;
    const capabilities = isRecord(metadata.capabilities) ? metadata.capabilities : undefined;

    return {
      id: modelId,
      name: typeof metadata.name === 'string' && metadata.name.trim() !== '' ? metadata.name : modelId,
      description:
        typeof metadata.description === 'string' && metadata.description.trim() !== ''
          ? metadata.description
          : undefined,
      contextWindow:
        typeof limit?.context === 'number' && limit.context > 0 ? limit.context : undefined,
      maxInputTokens: typeof limit?.input === 'number' && limit.input > 0 ? limit.input : undefined,
      maxTokens: typeof limit?.output === 'number' && limit.output > 0 ? limit.output : undefined,
      supportsVision:
        typeof capabilities?.attachment === 'boolean' ? capabilities.attachment : undefined,
      supportsTools:
        typeof capabilities?.toolcall === 'boolean' ? capabilities.toolcall : undefined,
      apiMode:
        isApiMode(metadata.api)
          ? metadata.api
          : isApiMode(metadata.apiMode)
            ? metadata.apiMode
            : undefined,
      reasoning:
        typeof capabilities?.reasoning === 'boolean' ? capabilities.reasoning : undefined,
      resetEmbeddedReasoningVariant:
        typeof metadata.resetEmbeddedReasoningVariant === 'boolean'
          ? metadata.resetEmbeddedReasoningVariant
          : undefined,
      variants:
        isRecord(metadata.variants) && Object.keys(metadata.variants).length > 0
          ? metadata.variants
          : undefined,
    } satisfies OmniRouteModel;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toProviderModels(
  models: OmniRouteModel[],
  baseUrl: string,
  config?: OmniRouteConfig,
): Record<string, OmniRouteProviderModel> {
  const entries: Array<[string, OmniRouteProviderModel]> = models.map((model) => [
    model.id,
    toProviderModel(model, baseUrl, config),
  ]);
  if (DEBUG) {
    for (const [, providerModel] of entries) {
      debugLog(
        `[OmniRoute] Hydrated model ${providerModel.id}: attachment=${providerModel.capabilities.attachment} input.image=${providerModel.capabilities.input.image} toolcall=${providerModel.capabilities.toolcall}`,
      );
    }
  }
  return Object.fromEntries(entries);
}

function toProviderModel(
  model: OmniRouteModel,
  baseUrl: string,
  config?: OmniRouteConfig,
): OmniRouteProviderModel {
  const apiMode = getEffectiveApiModeForModel(model, config?.apiMode ?? 'chat');
  const configured = getConfiguredModelMetadata(model.id, config);
  const effectiveModel = configured ? { ...model, ...configured } : model;
  const embeddedVariant = getEmbeddedReasoningVariant(model.id, effectiveModel);
  const supportsVisionOverride = getCapabilityOverride(model.id, configured, 'supportsVision');
  const supportsVision = typeof supportsVisionOverride === 'boolean'
    ? supportsVisionOverride
    : typeof model.supportsVision === 'boolean'
      ? model.supportsVision
      : supportsLikelyVisionInput(model.id);
  const supportsToolsOverride = getCapabilityOverride(model.id, configured, 'supportsTools');
  const supportsTools = typeof supportsToolsOverride === 'boolean'
    ? supportsToolsOverride
    : model.supportsTools !== false;
  const reasoning = getProviderModelReasoningSupport(
    effectiveModel,
    apiMode,
    embeddedVariant,
    config,
  );
  const variants = getVariants(effectiveModel, reasoning, apiMode);
  const providerUrl = getProviderUrl(baseUrl, apiMode);
  const providerNpm = getProviderNpm(apiMode, effectiveModel);
  const options =
    embeddedVariant && apiMode !== 'anthropic'
      ? getReasoningVariantOptions(embeddedVariant, apiMode)
      : {};

  return {
    id: model.id,
    name: model.id,
    providerID: OMNIROUTE_PROVIDER_ID,
    family: getModelFamily(model.id),
    release_date: '',
    api: {
      id: model.id,
      url: providerUrl,
      npm: providerNpm,
    },
    provider: {
      api: providerUrl,
      npm: providerNpm,
    },
    modalities: {
      input: supportsVision ? ['text', 'image'] : ['text'],
      output: ['text'],
    },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: supportsVision,
      toolcall: supportsTools,
      input: {
        text: true,
        image: supportsVision,
        audio: false,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        image: false,
        audio: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: model.pricing?.input ?? 0,
      output: model.pricing?.output ?? 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: getModelLimits(model),
    options,
    headers: {},
    status: 'active',
    variants,
  };
}

function getReasoningSupport(model: OmniRouteModel, config?: OmniRouteConfig): boolean {
  const configured = getConfiguredModelMetadata(model.id, config);
  if (typeof configured?.reasoning === 'boolean') {
    return configured.reasoning;
  }

  if (supportsWidelySupportedReasoningEfforts(model.id)) {
    return true;
  }

  if (typeof model.reasoning === 'boolean') {
    return model.reasoning;
  }

  return isOpenAiReasoningModel(model.id);
}

function getProviderModelReasoningSupport(
  model: OmniRouteModel,
  apiMode: OmniRouteApiMode,
  embeddedVariant: string | undefined,
  config?: OmniRouteConfig,
): boolean {
  if (embeddedVariant) {
    return false;
  }

  const configured = getConfiguredModelMetadata(model.id, config);
  if (typeof configured?.reasoning === 'boolean') {
    return configured.reasoning;
  }

  if (
    apiMode === 'chat' &&
    usesOpenAiCompatibleChatRuntime(model.owned_by) &&
    !isOpenAiReasoningModel(model.id)
  ) {
    return false;
  }

  return getReasoningSupport(model, config);
}

function supportsWidelySupportedReasoningEfforts(modelId: string): boolean {
  return /(^|[-_/])(gpt-5\.5|gpt-5\.4|gpt-5\.3-codex|gpt-5\.2-codex)(?:$|[-_/])/.test(
    modelId.toLowerCase(),
  );
}

function supportsLikelyVisionInput(modelId: string): boolean {
  return /(^|\/)(codex|cx)\/gpt-5|gpt-5(\.[0-9]+)?-codex|(^|\/)gpt-5(\.[0-9]+)?(?:$|[-_/])|(^|[-_/])o[34](?:$|[-_/])/.test(
    modelId.toLowerCase(),
  );
}

function isOpenAiReasoningModel(modelId: string): boolean {
  return /(^|[-_/])(gpt-5(?:\.[0-9]+)?|o[34])(?:$|[-_/])|gpt-5(\.[0-9]+)?-codex/.test(
    modelId.toLowerCase(),
  );
}

function isOpenAiCodexLikeModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const providerKey = getProviderKey(id);

  if (
    providerKey &&
    providerKey !== 'codex' &&
    providerKey !== 'cx' &&
    providerKey !== 'openai'
  ) {
    return false;
  }

  return /(^|\/)(codex|cx)\/gpt-5|gpt-5(\.[0-9]+)?-codex|^gpt-5(\.[0-9]+)?(?:$|[-_/])|^o[34](?:$|[-_/])/.test(
    id,
  );
}

function getProviderKey(modelId: string): string | null {
  const parts = modelId.split('/');
  if (parts.length < 2) {
    return null;
  }

  return parts[0] ?? null;
}

function getVariants(
  model: OmniRouteModel,
  reasoning: boolean,
  apiMode: OmniRouteApiMode,
): Record<string, unknown> {
  const supportsWidelySupportedEfforts = supportsWidelySupportedReasoningEfforts(model.id);
  const generatedEfforts = supportsXHighReasoningEffort(model.id)
    ? (['low', 'medium', 'high', 'xhigh'] as const)
    : (['low', 'medium', 'high'] as const);
  const shouldGenerateReasoningVariants =
    apiMode !== 'anthropic' &&
    (reasoning || supportsWidelySupportedEfforts) &&
    !hasEmbeddedReasoningVariant(model);

  const generated = shouldGenerateReasoningVariants
    ? Object.fromEntries(
        generatedEfforts.map((effort) => [
          effort,
          getReasoningVariantOptions(effort, apiMode, model.id),
        ]),
      )
    : {};

  if (model.variants && Object.keys(model.variants).length > 0) {
    return {
      ...generated,
      ...model.variants,
    };
  }

  return generated;
}

function supportsXHighReasoningEffort(modelId: string): boolean {
  return /(^|[-_/])(gpt-5\.5|gpt-5\.4|gpt-5\.3-codex|gpt-5\.2-codex)(?:$|[-_/])/.test(
    modelId.toLowerCase(),
  );
}

function getReasoningVariantOptions(
  effort: 'low' | 'medium' | 'high' | 'minimal' | 'none' | 'max' | 'xhigh',
  apiMode: OmniRouteApiMode,
  modelId?: string,
): Record<string, unknown> {
  if (apiMode !== 'responses' || !modelId || !isOpenAiCodexLikeModel(modelId)) {
    return { reasoningEffort: effort };
  }

  return {
    reasoningEffort: effort,
    reasoningSummary: 'auto',
    include: ['reasoning.encrypted_content'],
  };
}

function hasEmbeddedReasoningVariant(model: OmniRouteModel): boolean {
  return getEmbeddedReasoningVariant(model.id, model) !== undefined;
}

function getEmbeddedReasoningVariant(
  modelId: string,
  metadata?: Pick<OmniRouteModelMetadata, 'resetEmbeddedReasoningVariant'>,
): 'low' | 'medium' | 'high' | 'minimal' | 'none' | 'max' | 'xhigh' | undefined {
  if (metadata?.resetEmbeddedReasoningVariant === true) {
    return undefined;
  }

  const id = modelId.toLowerCase();
  const match = id.match(/(?:^|[-_/])(low|medium|high|minimal|none|max|xhigh)(?:$|[-_/])/);
  const effort = match?.[1];
  if (
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'minimal' ||
    effort === 'none' ||
    effort === 'max' ||
    effort === 'xhigh'
  ) {
    return effort;
  }
  return undefined;
}

function getConfiguredModelMetadata(
  modelId: string,
  config?: OmniRouteConfig,
): OmniRouteModelMetadata | undefined {
  const metadataConfig = config?.modelMetadata;
  if (!metadataConfig) {
    return undefined;
  }

  const metadata = Array.isArray(metadataConfig)
    ? getConfiguredModelMetadataFromBlocks(modelId, metadataConfig)
    : metadataConfig[modelId];

  return metadata && typeof metadata === 'object' ? metadata : undefined;
}

function getConfiguredModelMetadataFromBlocks(
  modelId: string,
  blocks: OmniRouteModelMetadataBlock[],
): OmniRouteModelMetadata | undefined {
  let merged: OmniRouteModelMetadata | undefined;

  for (const block of blocks) {
    const matcher = typeof block.match === 'string' ? block.match : coerceRegExp(block.match);
    const matches = typeof matcher === 'string' ? matcher === modelId : matcher?.test(modelId) === true;
    if (!matches) continue;

    const metadata = omitMatcherFields(block);
    merged = merged ? { ...merged, ...metadata } : metadata;
  }

  return merged;
}

function omitMatcherFields(
  block: OmniRouteModelMetadataBlock,
): OmniRouteModelMetadata {
  const { match: _match, addIfMissing: _addIfMissing, ...metadata } = block;
  return metadata;
}

function getCapabilityOverride(
  modelId: string,
  metadata: OmniRouteModelMetadata | undefined,
  key: 'supportsVision' | 'supportsTools' | 'reasoning',
): boolean | undefined {
  const value = metadata?.[key];
  if (typeof value !== 'boolean') return undefined;

  if (key === 'supportsVision' && value === false && supportsLikelyVisionInput(modelId)) {
    return undefined;
  }

  return value;
}

function getModelFamily(modelId: string): string {
  const [family] = modelId.split('-');
  return family || modelId;
}

function getModelLimits(model: OmniRouteModel): { context: number; input?: number; output: number } {
  const explicitContext = model.contextWindow;
  const explicitInput = model.maxInputTokens;
  const explicitOutput = model.maxTokens;
  const modelId = model.id.toLowerCase();
  const codexLike = isOpenAiCodexLikeModel(modelId);

  if (codexLike) {
    const context = explicitContext ?? 256000;
    const output = explicitOutput ?? 32000;
    const input = explicitInput ?? Math.max(8192, context - output);
    return { context, input, output };
  }

  const context = explicitContext ?? 32768;
  const output = explicitOutput ?? 8192;
  if (explicitInput !== undefined) {
    return { context, input: explicitInput, output };
  }
  if (context > output) {
    return { context, input: context - output, output };
  }
  return { context, output };
}

/**
 * Create fetch interceptor for OmniRoute API
 *
 * @param config - OmniRoute configuration
 * @returns Fetch interceptor function
 */
function createFetchInterceptor(
  config: OmniRouteConfig,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const baseUrl = config.baseUrl || 'http://localhost:20128/v1';

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Properly extract URL from RequestInfo (handles Request objects correctly)
    const url = input instanceof Request ? input.url : input.toString();

    // Only intercept requests to the configured OmniRoute base URL
    // Ensure baseUrl ends with a slash for safe prefix matching to prevent domain spoofing
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const isOmniRouteRequest = url === baseUrl || url.startsWith(normalizedBaseUrl);

    if (!isOmniRouteRequest) {
      // Pass through non-OmniRoute requests
      return fetch(input, init);
    }

    debugLog(`[OmniRoute] Intercepting request to ${url}`);

    // Merge headers from Request and init to avoid dropping existing headers
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      const initHeaders = new Headers(init.headers);
      initHeaders.forEach((value, key) => {
        headers.set(key, value);
      });
    }

    headers.set('Authorization', `Bearer ${config.apiKey}`);
    if (url.includes('/messages')) {
      headers.set('x-api-key', config.apiKey);
      if (!headers.has('anthropic-beta')) {
        headers.set('anthropic-beta', OMNIROUTE_ANTHROPIC_BETA_HEADER);
      }
    }
    headers.set('Content-Type', 'application/json');

    const requestConfig = getRequestRuntimeConfig(config);
    const transformedBody = await transformRequestBody(input, init, url, requestConfig);
    if (DEBUG && transformedBody !== undefined) {
      if (url.includes('/chat/completions')) {
        debugLog(`[OmniRoute] Final chat payload ${transformedBody}`);
      }
      if (url.includes('/messages')) {
        debugLog(`[OmniRoute] Final messages payload ${sanitizeDebugPayload(transformedBody)}`);
      }
    }

    // Clone init to avoid mutating original
    const modifiedInit: RequestInit = {
      ...init,
      headers,
      ...(transformedBody !== undefined ? { body: transformedBody } : {}),
    };

    // Make the request
    const response = await fetch(input, modifiedInit);

    // Handle model fetching endpoint specially
    if (url.includes('/v1/models') && response.ok) {
      debugLog('[OmniRoute] Processing /v1/models response');
    }

    return sanitizeAnthropicMessagesResponse(url, response);
  };
}

function getRequestRuntimeConfig(config: OmniRouteConfig): OmniRouteConfig {
  const liveStripOpenCodeSystemPrompt = getConfiguredStripOpenCodeSystemPromptStatus();
  return {
    ...config,
    stripOpenCodeSystemPrompt: liveStripOpenCodeSystemPrompt ?? config.stripOpenCodeSystemPrompt,
  };
}

interface SseEventChunk {
  event: string | undefined;
  data: string[];
  lines: string[];
}

function sanitizeAnthropicMessagesResponse(url: string, response: Response): Response {
  if (!url.includes('/messages') || !response.body) {
    return response;
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/event-stream')) {
    return response;
  }

  return new Response(createAnthropicSseSanitizer(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createAnthropicSseSanitizer(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = body.getReader();
  const state: SseEventChunk = { event: undefined, data: [], lines: [] };
  let buffer = '';

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        while (true) {
          const emitted = flushBufferedSseLines(controller, state, false, () => buffer, (next) => {
            buffer = next;
          }, encoder);
          if (emitted) {
            return;
          }

          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            flushBufferedSseLines(controller, state, true, () => buffer, (next) => {
              buffer = next;
            }, encoder);
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason): void {
      void reader.cancel(reason);
    },
  });
}

function flushBufferedSseLines(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: SseEventChunk,
  isFinal: boolean,
  getBuffer: () => string,
  setBuffer: (value: string) => void,
  encoder: TextEncoder,
): boolean {
  let emitted = false;
  let buffer = getBuffer();
  let line = consumeSseLine(buffer);

  while (line) {
    buffer = line.rest;
    const eventText = ingestSseLine(state, line.value);
    if (eventText !== undefined) {
      if (shouldForwardAnthropicSseEvent(eventText.event, eventText.data)) {
        controller.enqueue(encoder.encode(eventText.raw));
        emitted = true;
      } else {
        debugLog(`[OmniRoute] Dropped invalid Anthropic SSE event ${eventText.event ?? '(none)'}`);
      }
    }
    line = consumeSseLine(buffer);
  }

  setBuffer(buffer);

  if (isFinal) {
    if (buffer.length > 0) {
      const eventText = ingestSseLine(state, buffer);
      setBuffer('');
      if (eventText !== undefined && shouldForwardAnthropicSseEvent(eventText.event, eventText.data)) {
        controller.enqueue(encoder.encode(eventText.raw));
        emitted = true;
      }
    }

    const trailingEvent = flushSseEventChunk(state);
    if (trailingEvent !== undefined && shouldForwardAnthropicSseEvent(trailingEvent.event, trailingEvent.data)) {
      controller.enqueue(encoder.encode(trailingEvent.raw));
      emitted = true;
    }
  }

  return emitted;
}

function consumeSseLine(text: string): { value: string; rest: string } | undefined {
  const carriageReturnIndex = text.indexOf('\r');
  const newlineIndex = text.indexOf('\n');
  let lineBreakIndex: number;

  if (carriageReturnIndex === -1) {
    lineBreakIndex = newlineIndex;
  } else if (newlineIndex === -1) {
    lineBreakIndex = carriageReturnIndex;
  } else {
    lineBreakIndex = Math.min(carriageReturnIndex, newlineIndex);
  }

  if (lineBreakIndex === -1) {
    return undefined;
  }

  let nextIndex = lineBreakIndex + 1;
  if (text[lineBreakIndex] === '\r' && text[nextIndex] === '\n') {
    nextIndex += 1;
  }

  return {
    value: text.slice(0, lineBreakIndex),
    rest: text.slice(nextIndex),
  };
}

function ingestSseLine(
  state: SseEventChunk,
  line: string,
): { event: string | undefined; data: string; raw: string } | undefined {
  if (line === '') {
    return flushSseEventChunk(state);
  }

  state.lines.push(line);
  if (line.startsWith(':')) {
    return undefined;
  }

  const delimiterIndex = line.indexOf(':');
  const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
  let value = delimiterIndex === -1 ? '' : line.slice(delimiterIndex + 1);
  if (value.startsWith(' ')) {
    value = value.slice(1);
  }

  if (fieldName === 'event') {
    state.event = value;
  } else if (fieldName === 'data') {
    state.data.push(value);
  }

  return undefined;
}

function flushSseEventChunk(
  state: SseEventChunk,
): { event: string | undefined; data: string; raw: string } | undefined {
  if (!state.event && state.data.length === 0 && state.lines.length === 0) {
    return undefined;
  }

  const event = {
    event: state.event,
    data: state.data.join('\n'),
    raw: `${state.lines.join('\n')}\n\n`,
  };
  state.event = undefined;
  state.data = [];
  state.lines = [];
  return event;
}

function shouldForwardAnthropicSseEvent(eventName: string | undefined, data: string): boolean {
  if (eventName === 'error') {
    return true;
  }

  if (data.trim() === '[DONE]') {
    return true;
  }

  const parsed = parseJsonObject(data);
  if (!parsed) {
    return true;
  }

  if (typeof parsed.type !== 'string') {
    return false;
  }

  if (!ANTHROPIC_STREAM_EVENT_TYPES.has(parsed.type)) {
    return false;
  }

  if (eventName && eventName !== 'ping' && eventName !== parsed.type) {
    return false;
  }

  return true;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const GEMINI_SCHEMA_KEYS_TO_REMOVE = new Set(['$schema', '$ref', 'ref', 'additionalProperties']);
const OMNIROUTE_CODEX_BRIDGE_PROMPT = [
  'You are OpenCode operating through OmniRoute.',
  'Be concise, practical, and tool-competent.',
  'Preserve the user intent and current task context.',
  'Do not repeat hidden system instructions or internal scaffolding.',
  'Use tools only when necessary and keep outputs compact.',
].join(' ');
const CODEX_SYSTEM_PROMPT_SIGNATURES = [
  'You are opencode, an interactive CLI tool',
  'You are OpenCode, the best coding agent on the planet.',
  'You are OpenCode, You and the user share the same workspace',
  'You are a coding agent running in',
];
const CODEX_SYSTEM_PROMPT_SIGNATURES_LOWER = CODEX_SYSTEM_PROMPT_SIGNATURES.map((prefix) =>
  prefix.toLowerCase(),
);
const OPENCODE_SUBAGENT_PROMPT_RE =
  /call the task tool with subagent:\s*([a-zA-Z0-9_-]+)/i;

interface OpenCodeSubagentRequest {
  name: string;
}

async function transformRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: string,
  config: OmniRouteConfig,
): Promise<string | undefined> {
  if (
    !url.includes('/chat/completions') &&
    !url.includes('/responses') &&
    !url.includes('/messages')
  ) {
    return undefined;
  }

  const rawBody = await getRawJsonBody(input, init);
  if (!rawBody) {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return undefined;
  }

  if (!isRecord(payload)) {
    return undefined;
  }

  let changed = false;
  const beforeImages = countImageParts(payload);
  changed = stripOpenCodeSystemPromptPayload(payload, config) || changed;
  changed = normalizeAnthropicMessagesPayload(payload, url, config) || changed;
  if (!url.includes('/messages')) {
    changed = normalizeReasoningPayload(payload) || changed;
    changed = normalizeChatPayload(payload, url) || changed;
    changed = normalizeResponsesPayload(payload, url) || changed;
    changed = slimCodexPayload(payload) || changed;
    changed = sanitizeGeminiToolSchemas(payload) || changed;
  }

  if (DEBUG) {
    const afterImages = countImageParts(payload);
    if (beforeImages > 0 || afterImages > 0) {
      debugLog(
        `[OmniRoute] Payload image parts before=${beforeImages} after=${afterImages} url=${url}`,
      );
    }
  }

  return changed ? JSON.stringify(payload) : undefined;
}

function normalizeAnthropicMessagesPayload(
  payload: Record<string, unknown>,
  url: string,
  config: OmniRouteConfig,
): boolean {
  if (!url.includes('/messages')) {
    return false;
  }

  if (!canOverrideAnthropicToolChoice(payload.tool_choice)) {
    return false;
  }

  const subagentRequest = findRequestedOpenCodeSubagent(payload.messages);
  if (subagentRequest && hasToolNamed(payload.tools, 'task')) {
    payload.tool_choice = {
      type: 'tool',
      name: 'task',
    };
    debugLog(`[OmniRoute] Forced Anthropic task tool for @${subagentRequest.name}`);
    return true;
  }

  if (shouldForceAnthropicReadAfterGlob(payload, config.anthropicToolChoice)) {
    appendAnthropicStarterToolInstruction(payload.messages, 'read');
    payload.tool_choice = {
      type: 'tool',
      name: 'read',
    };
    debugLog('[OmniRoute] Forced Anthropic follow-up tool: read');
    return true;
  }

  const starterTool = getAnthropicStarterTool(payload, config.anthropicToolChoice);
  if (starterTool) {
    appendAnthropicStarterToolInstruction(payload.messages, starterTool);
    payload.tool_choice = {
      type: 'tool',
      name: starterTool,
    };
    debugLog(`[OmniRoute] Forced Anthropic starter tool: ${starterTool}`);
    return true;
  }

  if (shouldForceAnthropicAnyTool(payload, config.anthropicToolChoice)) {
    payload.tool_choice = {
      type: 'any',
    };
    debugLog('[OmniRoute] Forced Anthropic tool use with tool_choice=any');
    return true;
  }

  return false;
}

function canOverrideAnthropicToolChoice(toolChoice: unknown): boolean {
  if (toolChoice === undefined) {
    return true;
  }

  if (toolChoice === 'auto') {
    return true;
  }

  return isRecord(toolChoice) && toolChoice.type === 'auto';
}

function hasEnabledAnthropicThinking(thinking: unknown): boolean {
  if (thinking === undefined || thinking === false) {
    return false;
  }

  if (!isRecord(thinking)) {
    return true;
  }

  return thinking.type !== 'disabled';
}

function hasToolNamed(tools: unknown, name: string): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }

  return tools.some((tool) => isRecord(tool) && tool.name === name);
}

function shouldForceAnthropicReadAfterGlob(
  payload: Record<string, unknown>,
  policy: OmniRouteAnthropicToolChoicePolicy | undefined,
): boolean {
  if (policy === 'auto' || !isCursorComposerPayloadModel(payload.model)) {
    return false;
  }

  if (!hasToolNamed(payload.tools, 'read')) {
    return false;
  }

  const firstUserText = getFirstUserMessageText(payload.messages)?.toLowerCase() ?? '';
  if (!/(^|\b)(explore|pelajari|inspect|map|petakan|struktur)(\b|$)/i.test(firstUserText)) {
    return false;
  }

  return hasAssistantToolUse(payload.messages, 'glob') && !hasAssistantToolUse(payload.messages, 'read');
}

function getFirstUserMessageText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const message = messages.find((item) => isRecord(item) && item.role === 'user');
  return isRecord(message) ? collectTextContent(message.content ?? message).join('\n') : undefined;
}

function hasAssistantToolUse(messages: unknown, name: string): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }

  return messages.some((message) => {
    if (!isRecord(message) || message.role !== 'assistant') {
      return false;
    }

    return Array.isArray(message.content) && message.content.some(
      (part) => isRecord(part) && part.type === 'tool_use' && part.name === name,
    );
  });
}

function appendAnthropicStarterToolInstruction(messages: unknown, toolName: string): void {
  const latestUser = getLatestUserMessage(messages);
  if (!latestUser) {
    return;
  }

  const instruction =
    toolName === 'glob'
      ? 'Before answering, call the glob tool first with pattern "**/*" to inspect this project.'
      : `Before answering, call the ${toolName} tool first to inspect this project.`;

  if (typeof latestUser.content === 'string') {
    if (!latestUser.content.includes(instruction)) {
      latestUser.content = `${latestUser.content}\n\n${instruction}`;
    }
    return;
  }

  if (Array.isArray(latestUser.content)) {
    const hasInstruction = latestUser.content.some(
      (part) => isRecord(part) && part.type === 'text' && part.text === instruction,
    );
    if (!hasInstruction) {
      latestUser.content.push({ type: 'text', text: instruction });
    }
  }
}

function getAnthropicStarterTool(
  payload: Record<string, unknown>,
  policy: OmniRouteAnthropicToolChoicePolicy | undefined,
): string | undefined {
  if (policy === 'auto') {
    return undefined;
  }

  if (!isCursorComposerPayloadModel(payload.model)) {
    return undefined;
  }

  const latestUserText = getLatestUserMessageText(payload.messages)?.toLowerCase() ?? '';
  if (!/(^|\b)(explore|pelajari|inspect|map|petakan|struktur)(\b|$)/i.test(latestUserText)) {
    return undefined;
  }

  if (hasToolNamed(payload.tools, 'glob')) {
    return 'glob';
  }

  if (hasToolNamed(payload.tools, 'read')) {
    return 'read';
  }

  return undefined;
}

function shouldForceAnthropicAnyTool(
  payload: Record<string, unknown>,
  policy: OmniRouteAnthropicToolChoicePolicy | undefined,
): boolean {
  if (!hasAnyNamedTool(payload.tools)) {
    return false;
  }

  if (hasAssistantToolUse(payload.messages, 'glob') || hasAssistantToolUse(payload.messages, 'read')) {
    return false;
  }

  if (policy === 'auto') {
    return false;
  }

  if (policy === 'any') {
    return true;
  }

  return isCursorComposerPayloadModel(payload.model);
}

function sanitizeDebugPayload(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!isRecord(parsed)) {
      return rawBody;
    }

    const sanitized: Record<string, unknown> = {
      model: parsed.model,
      max_tokens: parsed.max_tokens,
      thinking: parsed.thinking,
      tool_choice: parsed.tool_choice,
      tools: Array.isArray(parsed.tools)
        ? parsed.tools.map((tool) => (isRecord(tool) ? tool.name : undefined))
        : undefined,
      messages: Array.isArray(parsed.messages)
        ? parsed.messages.map((message) => {
            if (!isRecord(message)) return message;
            return {
              role: message.role,
              contentTypes: Array.isArray(message.content)
                ? message.content.map((part) => (isRecord(part) ? part.type : typeof part))
                : typeof message.content,
            };
          })
        : undefined,
    };

    return JSON.stringify(sanitized);
  } catch {
    return rawBody;
  }
}

function hasAnyNamedTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }

  return tools.some((tool) => isRecord(tool) && typeof tool.name === 'string');
}

function isCursorComposerPayloadModel(model: unknown): boolean {
  return typeof model === 'string' && isCursorComposerModel(model);
}

function findRequestedOpenCodeSubagent(
  messages: unknown,
): OpenCodeSubagentRequest | undefined {
  const latestUserText = getLatestUserMessageText(messages);
  const text = latestUserText ?? collectTextContent(messages).join('\n');
  const agentPartMatch = text.match(OPENCODE_SUBAGENT_PROMPT_RE);
  if (agentPartMatch?.[1]) {
    return {
      name: agentPartMatch[1],
    };
  }

  return undefined;
}

function getLatestUserMessageText(messages: unknown): string | undefined {
  const message = getLatestUserMessage(messages);
  if (!message) {
    return undefined;
  }

  return collectTextContent(message.content ?? message).join('\n');
}

function getLatestUserMessage(messages: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) {
      continue;
    }
    if (message.role === 'user') {
      return message;
    }
  }

  return undefined;
}

function collectTextContent(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextContent(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const current = typeof value.text === 'string' ? [value.text] : [];
  return [
    ...current,
    ...collectTextContent(value.content),
  ];
}

function normalizeResponsesPayload(payload: Record<string, unknown>, url: string): boolean {
  if (!url.includes('/responses')) {
    return false;
  }

  let changed = false;
  const model = typeof payload.model === 'string' ? payload.model : '';
  const keepOpenAiProgressFields = isOpenAiCodexLikeModel(model);

  if (keepOpenAiProgressFields) {
    changed = ensureOpenAiReasoningSummary(payload) || changed;
  }

  if (payload.max_output_tokens !== undefined) {
    delete payload.max_output_tokens;
    changed = true;
  }

  if (payload.max_tokens !== undefined) {
    delete payload.max_tokens;
    changed = true;
  }

  if (payload.reasoningEffort !== undefined) {
    delete payload.reasoningEffort;
    changed = true;
  }

  if (!keepOpenAiProgressFields && payload.textVerbosity !== undefined) {
    delete payload.textVerbosity;
    changed = true;
  }

  if (payload.reasoning_effort !== undefined) {
    delete payload.reasoning_effort;
    changed = true;
  }

  if (!keepOpenAiProgressFields && payload.reasoningSummary !== undefined) {
    delete payload.reasoningSummary;
    changed = true;
  }

  if (payload.reasoning_summary !== undefined) {
    delete payload.reasoning_summary;
    changed = true;
  }

  if (payload.temperature !== undefined) {
    delete payload.temperature;
    changed = true;
  }

  return changed;
}

function ensureOpenAiReasoningSummary(payload: Record<string, unknown>): boolean {
  let changed = false;

  const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
  if (!isRecord(payload.reasoning)) {
    payload.reasoning = reasoning;
    changed = true;
  }

  if (typeof reasoning.effort !== 'string') {
    reasoning.effort = typeof payload.reasoningEffort === 'string' ? payload.reasoningEffort : 'medium';
    changed = true;
  }

  if (reasoning.summary !== 'auto') {
    reasoning.summary = 'auto';
    changed = true;
  }

  if (!Array.isArray(payload.include)) {
    payload.include = ['reasoning.encrypted_content'];
    return true;
  }

  if (!payload.include.includes('reasoning.encrypted_content')) {
    payload.include = [...payload.include, 'reasoning.encrypted_content'];
    changed = true;
  }

  return changed;
}

function normalizeChatPayload(payload: Record<string, unknown>, url: string): boolean {
  if (!url.includes('/chat/completions')) {
    return false;
  }

  let changed = false;
  const model = typeof payload.model === 'string' ? payload.model : '';
  const keepReasoning = isOpenAiReasoningModel(model);
  const keepVerbosity = isOpenAiCodexLikeModel(model);

  if (payload.input !== undefined && payload.messages === undefined) {
    payload.messages = normalizeChatMessagesFromInput(payload.input);
    delete payload.input;
    changed = true;
  }

  if (payload.reasoningSummary !== undefined) {
    delete payload.reasoningSummary;
    changed = true;
  }

  if (payload.reasoning_summary !== undefined) {
    delete payload.reasoning_summary;
    changed = true;
  }

  if (!keepReasoning) {
    if (payload.reasoning !== undefined) {
      delete payload.reasoning;
      changed = true;
    }
  }

  if (!keepVerbosity && payload.textVerbosity !== undefined) {
    delete payload.textVerbosity;
    changed = true;
  }

  if (!keepVerbosity && payload.verbosity !== undefined) {
    delete payload.verbosity;
    changed = true;
  }

  return changed;
}

function normalizeChatMessagesFromInput(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    const messages: unknown[] = [];
    for (const item of input) {
      if (!isRecord(item)) continue;

      const role = typeof item.role === 'string' ? item.role : 'user';
      const content = normalizeChatMessageContent(item.content ?? item.input_text ?? item.text);
      messages.push({ role, content });
    }

    return messages.length > 0 ? messages : [{ role: 'user', content: '' }];
  }

  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }

  return [{ role: 'user', content: '' }];
}

function normalizeChatMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;

    if (typeof part.text === 'string') {
      parts.push(part.text);
      continue;
    }

    if (typeof part.input_text === 'string') {
      parts.push(part.input_text);
      continue;
    }

    if (part.type === 'input_text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }

  return parts.join('\n');
}

function sanitizeGeminiToolSchemas(payload: Record<string, unknown>): boolean {
  const model = payload.model;
  if (typeof model !== 'string' || !model.toLowerCase().includes('gemini')) {
    return false;
  }

  let changed = preserveGeminiThoughtSignatures(payload);
  changed = wrapGeminiToolsAsFunctionDeclarations(payload) || changed;

  const tools = payload.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return changed;
  }

  changed = sanitizeToolSchemaContainer(payload) || changed;
  if (changed) {
    debugLog('[OmniRoute] Sanitized Gemini tool schema keywords');
  }

  return changed;
}

function preserveGeminiThoughtSignatures(payload: Record<string, unknown>): boolean {
  let changed = false;

  const signatures = collectGeminiThoughtSignatures(payload);
  if (signatures.length === 0) {
    return false;
  }

  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!isRecord(message) || !Array.isArray(message.content)) {
        continue;
      }

      for (const part of message.content) {
        if (!isRecord(part)) continue;

        const toolCall = isRecord(part.toolCall) ? part.toolCall : undefined;
        const functionCall = isRecord(part.functionCall) ? part.functionCall : undefined;
        const source = toolCall ?? functionCall;
        if (!source) continue;

        const signature =
          typeof source.thought_signature === 'string'
            ? source.thought_signature
            : typeof source.thoughtSignature === 'string'
              ? source.thoughtSignature
              : typeof part.thought_signature === 'string'
                ? part.thought_signature
                : typeof part.thoughtSignature === 'string'
                  ? part.thoughtSignature
                  : signatures[0];

        if (!signature) continue;

        if (toolCall && typeof toolCall.thought_signature !== 'string') {
          toolCall.thought_signature = signature;
          changed = true;
        }

        if (functionCall && typeof functionCall.thought_signature !== 'string') {
          functionCall.thought_signature = signature;
          changed = true;
        }

        if (typeof part.thought_signature !== 'string') {
          part.thought_signature = signature;
          changed = true;
        }
      }
    }
  }

  changed = normalizeGeminiInputThoughtSignatures(payload.input, signatures) || changed;

  return changed;
}

function collectGeminiThoughtSignatures(payload: Record<string, unknown>): string[] {
  const signatures = new Set<string>();
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  const collectFromPart = (part: unknown): void => {
    if (!isRecord(part)) return;

    const candidates = [
      part.thought_signature,
      part.thoughtSignature,
      isRecord(part.toolCall) ? part.toolCall.thought_signature : undefined,
      isRecord(part.toolCall) ? part.toolCall.thoughtSignature : undefined,
      isRecord(part.functionCall) ? part.functionCall.thought_signature : undefined,
      isRecord(part.functionCall) ? part.functionCall.thoughtSignature : undefined,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        signatures.add(candidate);
      }
    }
  };

  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      collectFromPart(part);
    }
  }

  return [...signatures];
}

function normalizeGeminiInputThoughtSignatures(input: unknown, signatures: string[]): boolean {
  if (!Array.isArray(input) || signatures.length === 0) {
    return false;
  }

  let changed = false;
  let signatureIndex = 0;

  for (const item of input) {
    if (!isRecord(item)) continue;

    const type = typeof item.type === 'string' ? item.type : '';
    const functionCall = isRecord(item.functionCall) ? item.functionCall : undefined;
    const likelyFunctionCall =
      type === 'function_call' ||
      type === 'functionCall' ||
      functionCall !== undefined ||
      (typeof item.name === 'string' && item.arguments !== undefined);

    if (!likelyFunctionCall) continue;

    const existing =
      typeof item.thought_signature === 'string'
        ? item.thought_signature
        : typeof item.thoughtSignature === 'string'
          ? item.thoughtSignature
          : functionCall && typeof functionCall.thought_signature === 'string'
            ? functionCall.thought_signature
            : functionCall && typeof functionCall.thoughtSignature === 'string'
              ? functionCall.thoughtSignature
              : undefined;

    const nextSignature = existing ?? signatures[Math.min(signatureIndex, signatures.length - 1)];
    if (!nextSignature) continue;

    if (typeof item.thought_signature !== 'string') {
      item.thought_signature = nextSignature;
      changed = true;
    }

    if (functionCall && typeof functionCall.thought_signature !== 'string') {
      functionCall.thought_signature = nextSignature;
      changed = true;
    }

    signatureIndex += 1;
  }

  return changed;
}

function wrapGeminiToolsAsFunctionDeclarations(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    return false;
  }

  const tools = payload.tools as unknown[];
  const functionDeclarations: Array<Record<string, unknown>> = [];
  const passthrough: unknown[] = [];
  let changed = false;

  for (const tool of tools) {
    if (!isRecord(tool)) {
      passthrough.push(tool);
      continue;
    }

    if (Array.isArray(tool.functionDeclarations)) {
      passthrough.push(tool);
      continue;
    }

    if (tool.googleSearch || tool.googleSearchRetrieval || tool.codeExecution) {
      passthrough.push(tool);
      continue;
    }

    const fn = isRecord(tool.function) ? tool.function : undefined;
    const custom = isRecord(tool.custom) ? tool.custom : undefined;

    const name =
      typeof tool.name === 'string'
        ? tool.name
        : typeof fn?.name === 'string'
          ? fn.name
          : typeof custom?.name === 'string'
            ? custom.name
            : undefined;

    if (!name) {
      passthrough.push(tool);
      continue;
    }

    const description =
      typeof tool.description === 'string'
        ? tool.description
        : typeof fn?.description === 'string'
          ? fn.description
          : typeof custom?.description === 'string'
            ? custom.description
            : '';

    const parameters =
      (isRecord(fn?.input_schema) ? fn?.input_schema : undefined) ??
      (isRecord(fn?.parameters) ? fn?.parameters : undefined) ??
      (isRecord(fn?.inputSchema) ? fn?.inputSchema : undefined) ??
      (isRecord(custom?.input_schema) ? custom?.input_schema : undefined) ??
      (isRecord(custom?.parameters) ? custom?.parameters : undefined) ??
      (isRecord(tool.parameters) ? tool.parameters : undefined) ??
      (isRecord(tool.input_schema) ? tool.input_schema : undefined) ??
      (isRecord(tool.inputSchema) ? tool.inputSchema : undefined) ??
      { type: 'OBJECT', properties: {} };

    if (isRecord(parameters)) {
      stripSchemaKeys(parameters);
    }

    functionDeclarations.push({
      name,
      description,
      parameters,
    });
    changed = true;
  }

  if (!changed) {
    return false;
  }

  const nextTools: unknown[] = [];
  if (functionDeclarations.length > 0) {
    nextTools.push({ functionDeclarations });
  }
  nextTools.push(...passthrough);
  payload.tools = nextTools;
  return true;
}

function normalizeReasoningPayload(payload: Record<string, unknown>): boolean {
  let changed = false;

  const effort =
    typeof payload.reasoningEffort === 'string'
      ? payload.reasoningEffort
      : typeof payload.reasoning_effort === 'string'
        ? payload.reasoning_effort
        : isRecord(payload.reasoning) && typeof payload.reasoning.effort === 'string'
          ? payload.reasoning.effort
          : undefined;

  if (typeof payload.reasoningEffort === 'string') {
    delete payload.reasoningEffort;
    changed = true;
  }

  if (typeof payload.reasoning_effort === 'string') {
    delete payload.reasoning_effort;
    changed = true;
  }

  if (effort) {
    payload.reasoning = {
      ...(isRecord(payload.reasoning) ? payload.reasoning : {}),
      effort,
    };
    changed = true;
  }

  return changed;
}

function slimCodexPayload(payload: Record<string, unknown>): boolean {
  const model = typeof payload.model === 'string' ? payload.model.toLowerCase() : '';
  if (!isOpenAiCodexLikeModel(model)) {
    return false;
  }

  let changed = false;

  if (Array.isArray(payload.messages)) {
    const messages = payload.messages as unknown[];
    const originalLength = messages.length;
    const filtered = messages.filter((msg) => !isOpenCodeSystemMessage(msg));
    if (filtered.length !== originalLength) {
      payload.messages = filtered;
      changed = true;
    }

    const nextMessages = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : filtered;
    const hasBridge = nextMessages.some(
      (msg) => isRecord(msg) && (msg.role === 'system' || msg.role === 'developer') && msg.content === OMNIROUTE_CODEX_BRIDGE_PROMPT,
    );
    if (!hasBridge) {
      payload.messages = [{ role: 'system', content: OMNIROUTE_CODEX_BRIDGE_PROMPT }, ...nextMessages];
      changed = true;
    }
  }

  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    changed = slimToolDefinitions(payload.tools) || changed;
  }

  if (payload.store !== false) {
    payload.store = false;
    changed = true;
  }

  if (typeof payload.promptCacheKey === 'string' && typeof payload.prompt_cache_key !== 'string') {
    payload.prompt_cache_key = payload.promptCacheKey;
    changed = true;
  }

  if (payload.textVerbosity === 'low') {
    payload.textVerbosity = 'medium';
    changed = true;
  }

  debugLog('[OmniRoute] Applied Codex-compatible payload transform');
  return changed;
}

function stripOpenCodeSystemPromptPayload(
  payload: Record<string, unknown>,
  config: OmniRouteConfig,
): boolean {
  if (config.stripOpenCodeSystemPrompt !== true) {
    return false;
  }

  let changed = false;

  if (Array.isArray(payload.messages)) {
    const messages = payload.messages as unknown[];
    const filtered = stripOpenCodeSystemMessages(messages);
    if (filtered.length !== messages.length) {
      payload.messages = filtered;
      changed = true;
    }
  }

  if (Array.isArray(payload.input)) {
    const input = payload.input as unknown[];
    const filtered = stripOpenCodeSystemMessages(input);
    if (filtered.length !== input.length) {
      payload.input = filtered;
      changed = true;
    }
  }

  if (payload.system !== undefined) {
    delete payload.system;
    changed = true;
  }

  if (payload.instructions !== undefined) {
    delete payload.instructions;
    changed = true;
  }

  return changed;
}

function stripOpenCodeSystemMessages(messages: unknown[]): unknown[] {
  let firstNonSystemIndex = 0;
  while (firstNonSystemIndex < messages.length && isSystemLikeMessage(messages[firstNonSystemIndex])) {
    firstNonSystemIndex += 1;
  }

  const withoutLeadingSystem = messages.slice(firstNonSystemIndex);
  return withoutLeadingSystem.filter((message) => !isOpenCodeSystemMessage(message));
}

function isSystemLikeMessage(msg: unknown): boolean {
  if (!isRecord(msg)) return false;
  return msg.role === 'system' || msg.role === 'developer';
}

function isOpenCodeSystemMessage(msg: unknown): boolean {
  if (!isRecord(msg)) return false;
  const role = msg.role;
  const content = msg.content;
  if (role !== 'system' && role !== 'developer') return false;
  return isOpenCodeSystemPromptValue(content);
}

function isOpenCodeSystemPromptValue(value: unknown): boolean {
  const text = collectTextContent(value).join('\n').trimStart();
  if (text === '') {
    return false;
  }

  const normalizedText = text.toLowerCase();
  return CODEX_SYSTEM_PROMPT_SIGNATURES_LOWER.some((prefix) => normalizedText.startsWith(prefix));
}

function slimToolDefinitions(tools: unknown[]): boolean {
  let changed = false;
  for (const tool of tools) {
    if (!isRecord(tool) || !isRecord(tool.function)) continue;
    const fn = tool.function;

    if (typeof fn.description === 'string' && fn.description.length > 240) {
      fn.description = fn.description.slice(0, 240);
      changed = true;
    }

    if (isRecord(fn.parameters)) {
      changed = stripSchemaKeys(fn.parameters) || changed;
      changed = trimSchemaDescriptions(fn.parameters) || changed;
    }
  }
  return changed;
}

function trimSchemaDescriptions(schema: Record<string, unknown>): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' && typeof value === 'string' && value.length > 160) {
      schema[key] = value.slice(0, 160);
      changed = true;
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (isRecord(item)) changed = trimSchemaDescriptions(item) || changed;
      }
      continue;
    }

    if (isRecord(value)) {
      changed = trimSchemaDescriptions(value) || changed;
    }
  }
  return changed;
}

async function getRawJsonBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === 'string') {
    return init.body;
  }

  if (!(input instanceof Request)) {
    return undefined;
  }

  if (init?.body !== undefined) {
    return undefined;
  }

  const contentType = input.headers.get('content-type');
  if (!contentType || !contentType.toLowerCase().includes('application/json')) {
    return undefined;
  }

  return input.clone().text();
}

function sanitizeToolSchemaContainer(payload: Record<string, unknown>): boolean {
  const tools = payload.tools;
  if (!Array.isArray(tools)) {
    return false;
  }

  let changed = false;
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }

    if (isRecord(tool.function) && isRecord(tool.function.parameters)) {
      changed = stripSchemaKeys(tool.function.parameters) || changed;
    }

    if (isRecord(tool.function_declaration) && isRecord(tool.function_declaration.parameters)) {
      changed = stripSchemaKeys(tool.function_declaration.parameters) || changed;
    }

    if (isRecord(tool.input_schema)) {
      changed = stripSchemaKeys(tool.input_schema) || changed;
    }

    const functionDeclarations = tool.functionDeclarations;
    if (Array.isArray(functionDeclarations)) {
      for (const declaration of functionDeclarations) {
        if (isRecord(declaration) && isRecord(declaration.parameters)) {
          changed = stripSchemaKeys(declaration.parameters) || changed;
        }
      }
    }
  }

  return changed;
}

function stripSchemaKeys(schema: Record<string, unknown>): boolean {
  let changed = false;

  for (const key of Object.keys(schema)) {
    if (GEMINI_SCHEMA_KEYS_TO_REMOVE.has(key)) {
      delete schema[key];
      changed = true;
      continue;
    }

    const value = schema[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isRecord(item)) {
          changed = stripSchemaKeys(item) || changed;
        }
      }
      continue;
    }

    if (isRecord(value)) {
      changed = stripSchemaKeys(value) || changed;
    }
  }

  return changed;
}

function countImageParts(value: unknown): number {
  let total = 0;

  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }

    if (!isRecord(current)) {
      return;
    }

    const type = typeof current.type === 'string' ? current.type : undefined;
    const hasImageUrl = current.image_url !== undefined || current.imageUrl !== undefined;
    const hasFileRef = current.file_id !== undefined || current.fileId !== undefined;
    const hasInlineImage = current.image !== undefined;

    if (
      type === 'input_image' ||
      type === 'image' ||
      type === 'image_url' ||
      hasImageUrl ||
      hasFileRef ||
      hasInlineImage
    ) {
      total += 1;
    }

    for (const child of Object.values(current)) {
      visit(child);
    }
  };

  visit(value);
  return total;
}
