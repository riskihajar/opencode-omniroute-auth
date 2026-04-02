import type { Plugin, Hooks } from '@opencode-ai/plugin';
import type {
  OmniRouteApiMode,
  OmniRouteConfig,
  OmniRouteModel,
  OmniRouteModelMetadata,
  OmniRouteModelMetadataConfig,
  OmniRouteModelsDevConfig,
  OmniRouteProviderModel,
} from './types.js';
import {
  OMNIROUTE_PROVIDER_ID,
  OMNIROUTE_DEFAULT_MODELS,
  OMNIROUTE_ENDPOINTS,
} from './constants.js';
import { fetchModels } from './models.js';

const OMNIROUTE_PROVIDER_NAME = 'OmniRoute';
const OMNIROUTE_PROVIDER_NPM = '@ai-sdk/openai-compatible';
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

export const OmniRouteAuthPlugin: Plugin = async (_input) => {
  return {
    config: async (config) => {
      const providers = config.provider ?? {};
      const existingProvider = providers[OMNIROUTE_PROVIDER_ID];
      const baseUrl = getBaseUrl(existingProvider?.options);
      const apiMode = getApiMode(existingProvider?.options);
      const providerApi = resolveProviderApi(existingProvider?.api, apiMode);

      providers[OMNIROUTE_PROVIDER_ID] = {
        ...existingProvider,
        name: existingProvider?.name ?? OMNIROUTE_PROVIDER_NAME,
        api: providerApi,
        npm: existingProvider?.npm ?? OMNIROUTE_PROVIDER_NPM,
        env: existingProvider?.env ?? OMNIROUTE_PROVIDER_ENV,
        options: {
          ...(existingProvider?.options ?? {}),
          baseURL: baseUrl,
          apiMode,
        },
        models:
          existingProvider?.models && Object.keys(existingProvider.models).length > 0
            ? existingProvider.models
            : toProviderModels(OMNIROUTE_DEFAULT_MODELS, baseUrl, {
                baseUrl,
                apiKey: '',
                apiMode,
                modelMetadata: getModelMetadataConfig(existingProvider?.options),
              }),
      };

      config.provider = providers;
    },
    auth: createAuthHook(),
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
    fetch: createFetchInterceptor(config),
  };
}

function createRuntimeConfig(provider: ProviderDefinition, apiKey: string): OmniRouteConfig {
  const baseUrl = getBaseUrl(provider.options);
  const modelCacheTtl = getPositiveNumber(provider.options, 'modelCacheTtl');
  const refreshOnList = getBoolean(provider.options, 'refreshOnList');
  const modelsDev = getModelsDevConfig(provider.options);
  const modelMetadata = getModelMetadataConfig(provider.options);

  return {
    baseUrl,
    apiKey,
    apiMode: getApiMode(provider.options),
    modelCacheTtl,
    refreshOnList,
    modelsDev,
    modelMetadata,
  };
}

function resolveProviderApi(api: unknown, apiMode: OmniRouteApiMode): OmniRouteApiMode {
  if (isApiMode(api)) {
    if (api !== apiMode) {
      console.warn(
        `[OmniRoute] provider.api (${api}) and options.apiMode (${apiMode}) differ; using options.apiMode.`,
      );
    }
    return apiMode;
  }

  if (typeof api === 'string') {
    console.warn(`[OmniRoute] Unsupported provider.api value: ${api}. Using ${apiMode}.`);
  }

  return apiMode;
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

function isApiMode(value: unknown): value is OmniRouteApiMode {
  return value === 'chat' || value === 'responses';
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
  return Object.fromEntries(entries);
}

function toProviderModel(
  model: OmniRouteModel,
  baseUrl: string,
  config?: OmniRouteConfig,
): OmniRouteProviderModel {
  const supportsVision = model.supportsVision === true;
  const supportsTools = model.supportsTools !== false;
  const embeddedVariant = getEmbeddedReasoningVariant(model.id);
  const reasoning = embeddedVariant ? false : getReasoningSupport(model, config);
  const variants = getVariants(model, reasoning);
  const options = embeddedVariant ? { reasoningEffort: embeddedVariant } : {};

  return {
    id: model.id,
    name: model.name || model.id,
    providerID: OMNIROUTE_PROVIDER_ID,
    family: getModelFamily(model.id),
    release_date: '',
    api: {
      id: model.id,
      url: baseUrl,
      npm: OMNIROUTE_PROVIDER_NPM,
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
  if (typeof model.reasoning === 'boolean') {
    return model.reasoning;
  }

  const modelId = model.id.toLowerCase();
  const configured = getConfiguredModelMetadata(model.id, config);
  if (typeof configured?.reasoning === 'boolean') {
    return configured.reasoning;
  }

  return /(^|\/)(gpt-5|o3|o4)|codex\/gpt-5|cx\/gpt-5/.test(modelId);
}

function getVariants(model: OmniRouteModel, reasoning: boolean): Record<string, unknown> {
  if (model.variants && Object.keys(model.variants).length > 0) {
    return model.variants;
  }

  if (!reasoning || hasEmbeddedReasoningVariant(model.id)) {
    return {};
  }

  const variants: Record<string, unknown> = {
    low: { reasoningEffort: 'low' },
    medium: { reasoningEffort: 'medium' },
    high: { reasoningEffort: 'high' },
  };

  if (supportsXHighReasoning(model.id)) {
    variants.xhigh = { reasoningEffort: 'xhigh' };
  }

  return variants;
}

function supportsXHighReasoning(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes('gpt-5.2') || id.includes('gpt-5.3');
}

function hasEmbeddedReasoningVariant(modelId: string): boolean {
  return getEmbeddedReasoningVariant(modelId) !== undefined;
}

function getEmbeddedReasoningVariant(
  modelId: string,
): 'low' | 'medium' | 'high' | 'minimal' | 'none' | 'max' | 'xhigh' | undefined {
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
  if (!metadataConfig || Array.isArray(metadataConfig)) {
    return undefined;
  }
  const metadata = metadataConfig[modelId];
  return metadata && typeof metadata === 'object' ? metadata : undefined;
}

function getModelFamily(modelId: string): string {
  const [family] = modelId.split('-');
  return family || modelId;
}

function getModelLimits(model: OmniRouteModel): { context: number; input?: number; output: number } {
  const explicitContext = model.contextWindow;
  const explicitOutput = model.maxTokens;
  const modelId = model.id.toLowerCase();
  const codexLike = /(^|\/)(codex|cx)\/gpt-5|gpt-5(\.[0-9]+)?-codex|(^|\/)gpt-5(\.[0-9]+)?$|(^|[-_/])o[34](?:$|[-_/])/.test(modelId);

  if (codexLike) {
    const context = explicitContext ?? 256000;
    const output = explicitOutput ?? 32000;
    const input = Math.max(8192, context - output);
    return { context, input, output };
  }

  const context = explicitContext ?? 32768;
  const output = explicitOutput ?? 8192;
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
    headers.set('Content-Type', 'application/json');

    const transformedBody = await transformRequestBody(input, init, url);

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

    return response;
  };
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
  'You are OpenCode, the best coding agent on the planet.',
  'You are OpenCode, You and the user share the same workspace',
  'You are a coding agent running in',
];

async function transformRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: string,
): Promise<string | undefined> {
  if (!url.includes('/chat/completions') && !url.includes('/responses')) {
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
  changed = normalizeReasoningPayload(payload) || changed;
  changed = slimCodexPayload(payload) || changed;
  changed = sanitizeGeminiToolSchemas(payload) || changed;

  return changed ? JSON.stringify(payload) : undefined;
}

function sanitizeGeminiToolSchemas(payload: Record<string, unknown>): boolean {
  const model = payload.model;
  if (typeof model !== 'string' || !model.toLowerCase().includes('gemini')) {
    return false;
  }

  const tools = payload.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return false;
  }

  const changed = sanitizeToolSchemaContainer(payload);
  if (changed) {
    debugLog('[OmniRoute] Sanitized Gemini tool schema keywords');
  }

  return changed;
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
  const codexLike = /(^|\/)(codex|cx)\/gpt-5|gpt-5(\.[0-9]+)?-codex|(^|\/)gpt-5(\.[0-9]+)?$/.test(model);
  if (!codexLike) {
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

function isOpenCodeSystemMessage(msg: unknown): boolean {
  if (!isRecord(msg)) return false;
  const role = msg.role;
  const content = msg.content;
  if (role !== 'system' && role !== 'developer') return false;
  if (typeof content !== 'string') return false;
  return CODEX_SYSTEM_PROMPT_SIGNATURES.some((prefix) => content.startsWith(prefix));
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
