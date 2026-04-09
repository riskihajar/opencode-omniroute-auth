import type { OmniRouteConfig, OmniRouteModel, OmniRouteModelMetadata, OmniRouteModelsResponse } from './types.js';
import {
  OMNIROUTE_DEFAULT_MODELS,
  OMNIROUTE_ENDPOINTS,
  MODEL_CACHE_TTL,
  REQUEST_TIMEOUT,
} from './constants.js';
import {
  getModelsDevIndex,
  normalizeModelKey,
  type ModelsDevIndex,
  type ModelsDevModel,
} from './models-dev.js';
import { enrichComboModels, clearComboCache } from './omniroute-combos.js';

/**
 * Model cache entry
 */
interface ModelCache {
  models: OmniRouteModel[];
  timestamp: number;
}

/**
 * In-memory model cache keyed by endpoint and API key
 */
const modelCache = new Map<string, ModelCache>();

/**
 * Generate a cache key for a given configuration
 */
function getCacheKey(config: OmniRouteConfig, apiKey: string): string {
  const baseUrl = config.baseUrl || OMNIROUTE_ENDPOINTS.BASE_URL;
  return `${baseUrl}:${apiKey}`;
}

/**
 * Fetch models from OmniRoute /v1/models endpoint
 * This is the CRITICAL FEATURE - dynamically fetches available models
 *
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns Array of available models
 */
export async function fetchModels(
  config: OmniRouteConfig,
  apiKey: string,
  forceRefresh: boolean = false,
): Promise<OmniRouteModel[]> {
  const cacheKey = getCacheKey(config, apiKey);

  // Check cache first if not forcing refresh
  if (!forceRefresh) {
    // Validate TTL is positive to prevent unexpected cache behavior
    const cacheTtl =
      config.modelCacheTtl && config.modelCacheTtl > 0 ? config.modelCacheTtl : MODEL_CACHE_TTL;

    const cached = modelCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cacheTtl) {
      console.log('[OmniRoute] Using cached models');
      return cached.models;
    }
  } else {
    console.log('[OmniRoute] Forcing model refresh');
  }

  // Use default baseUrl if not provided to prevent undefined URL
  const baseUrl = config.baseUrl || OMNIROUTE_ENDPOINTS.BASE_URL;
  const modelsUrl = `${baseUrl}${OMNIROUTE_ENDPOINTS.MODELS}`;

  console.log(`[OmniRoute] Fetching models from ${modelsUrl}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      // Sanitize error - only log status, not response body
      console.error(
        `[OmniRoute] Failed to fetch models: ${response.status} ${response.statusText}`,
      );
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    // Parse and validate response structure before type casting
    const rawData = await response.json();

    // Runtime validation to ensure API returns expected structure
    if (!rawData || typeof rawData !== 'object' || !Array.isArray(rawData.data)) {
      console.error('[OmniRoute] Invalid models response structure:', rawData);
      throw new Error('Invalid models response structure: expected { data: Array }');
    }

    const data = rawData as OmniRouteModelsResponse;

    // Transform and validate models - filter out invalid entries
    const rawModels = data.data
      .filter(
        (model): model is OmniRouteModel =>
          model !== null && model !== undefined && typeof model.id === 'string',
      )
      .map((model) => ({
        ...model,
        // Ensure required fields
        id: model.id,
        name: model.name || model.id,
        root: typeof model.root === 'string' ? model.root : undefined,
        owned_by: typeof model.owned_by === 'string' ? model.owned_by : undefined,
        description: model.description || `OmniRoute model: ${model.id}`,
        // Keep undefined for enrichment to work properly
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsStreaming: model.supportsStreaming,
        supportsVision: model.supportsVision,
        supportsTools: model.supportsTools,
      }));

    // Enrich with models.dev and combo capabilities
    const models = await enrichModelMetadata(rawModels, config);

    // Update cache
    modelCache.set(cacheKey, {
      models,
      timestamp: Date.now(),
    });

    console.log(`[OmniRoute] Successfully fetched ${models.length} models`);
    return models;
  } catch (error) {
    console.error('[OmniRoute] Error fetching models:', error);

    // Return cached models if available (even if expired)
    const cached = modelCache.get(cacheKey);
    if (cached) {
      console.log('[OmniRoute] Returning expired cached models as fallback');
      return cached.models;
    }

    // Return default models as last resort
    console.log('[OmniRoute] Returning default models as fallback');
    return config.defaultModels || OMNIROUTE_DEFAULT_MODELS;
  } finally {
    // Always clear the timeout to prevent memory leaks
    clearTimeout(timeoutId);
  }
}

/**
 * Clear the model cache
 * @param config - Optional OmniRoute configuration to clear specific cache
 * @param apiKey - Optional API key to clear specific cache
 */
export function clearModelCache(config?: OmniRouteConfig, apiKey?: string): void {
  if (config && apiKey) {
    const cacheKey = getCacheKey(config, apiKey);
    modelCache.delete(cacheKey);
    console.log('[OmniRoute] Model cache cleared for provided configuration');
  } else {
    modelCache.clear();
    console.log('[OmniRoute] All model caches cleared');
  }
  // Also clear combo cache
  clearComboCache();
}

/**
 * Get cached models without fetching
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns Cached models or null
 */
export function getCachedModels(config: OmniRouteConfig, apiKey: string): OmniRouteModel[] | null {
  const cacheKey = getCacheKey(config, apiKey);
  return modelCache.get(cacheKey)?.models || null;
}

/**
 * Check if cache is valid
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns True if cache is valid
 */
export function isCacheValid(config: OmniRouteConfig, apiKey: string): boolean {
  const cacheKey = getCacheKey(config, apiKey);
  const cached = modelCache.get(cacheKey);
  if (!cached) return false;
  const ttl = config.modelCacheTtl || MODEL_CACHE_TTL;
  return Date.now() - cached.timestamp < ttl;
}

/**
 * Force refresh models from API
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns Array of available models
 */
export async function refreshModels(
  config: OmniRouteConfig,
  apiKey: string,
): Promise<OmniRouteModel[]> {
  clearModelCache();
  return fetchModels(config, apiKey, true);
}

/**
 * Enrich model metadata with models.dev data and combo capabilities
 */
async function enrichModelMetadata(
  models: OmniRouteModel[],
  config: OmniRouteConfig,
): Promise<OmniRouteModel[]> {
  const modelsDevIndex = await getModelsDevIndex(config);

  // Apply models.dev metadata enrichment
  const withModelsDev =
    modelsDevIndex === null
      ? models
      : models.map((model) => applyModelsDevMetadata(model, config, modelsDevIndex));

  const withOverrides = applyConfiguredModelMetadata(withModelsDev, config, modelsDevIndex);

  // Enrich combo models with lowest common capabilities
  const withComboCapabilities = await enrichComboModels(withOverrides, config, modelsDevIndex);

  return withComboCapabilities;
}

/**
 * Apply models.dev metadata to a model
 */
function applyModelsDevMetadata(
  model: OmniRouteModel,
  config: OmniRouteConfig,
  index: ModelsDevIndex,
): OmniRouteModel {
  const candidates = getModelsDevLookupCandidates(model, config);
  const best = findBestModelsDevMatch(candidates, index);

  if (!best) return model;

  // Merge capabilities (only fill in missing values)
  return mergeModelMetadata(model, metadataFromModelsDev(best));
}

function findBestModelsDevMatch(
  candidates: Array<{ providerAlias: string | null; modelKey: string }>,
  index: ModelsDevIndex,
): ModelsDevModel | undefined {
  for (const candidate of candidates) {
    const lookupKey = candidate.modelKey.toLowerCase();
    const normalizedKey = normalizeModelKey(candidate.modelKey);

    const providerExact = candidate.providerAlias
      ? index.exactByProvider.get(candidate.providerAlias)?.get(lookupKey)
      : undefined;
    if (providerExact) return providerExact;

    const providerNorm = candidate.providerAlias
      ? index.normalizedByProvider.get(candidate.providerAlias)?.get(normalizedKey)
      : undefined;
    if (providerNorm) return providerNorm;

    const globalExactList = index.exactGlobal.get(lookupKey);
    if (globalExactList?.length === 1) return globalExactList[0];

    const globalNormList = index.normalizedGlobal.get(normalizedKey);
    if (globalNormList?.length === 1) return globalNormList[0];
  }

  return undefined;
}

function getModelsDevLookupCandidates(
  model: OmniRouteModel,
  config: OmniRouteConfig,
): Array<{ providerAlias: string | null; modelKey: string }> {
  const { providerKey, modelKey } = splitOmniRouteModelForLookup(model.id);
  const providerAlias = resolveProviderAlias(providerKey, config);
  const candidates: Array<{ providerAlias: string | null; modelKey: string }> = [];
  const seen = new Set<string>();

  const addCandidate = (nextProviderAlias: string | null, nextModelKey: string | null | undefined): void => {
    if (!nextModelKey) return;
    const trimmedModelKey = nextModelKey.trim();
    if (!trimmedModelKey) return;

    const normalizedProvider = nextProviderAlias ? nextProviderAlias.toLowerCase() : 'global';
    const signature = `${normalizedProvider}:${trimmedModelKey.toLowerCase()}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push({ providerAlias: nextProviderAlias, modelKey: trimmedModelKey });
  };

  const lookupRoots = [model.root, modelKey].filter(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );

  for (const lookupRoot of lookupRoots) {
    addCandidate(providerAlias, lookupRoot);
    addCandidate(null, lookupRoot);

    for (const derived of deriveModelsDevFamilies(lookupRoot, providerAlias, model.owned_by)) {
      addCandidate(derived.providerAlias, derived.modelKey);
      addCandidate(null, derived.modelKey);
    }
  }

  return candidates;
}

function deriveModelsDevFamilies(
  modelKey: string,
  providerAlias: string | null,
  ownedBy?: string,
): Array<{ providerAlias: string; modelKey: string }> {
  const lower = modelKey.toLowerCase();
  const stripped = stripVariantSuffixes(modelKey);
  const strippedLower = stripped.toLowerCase();
  const matches: Array<{ providerAlias: string; modelKey: string }> = [];
  const slashFamily = extractSlashModelFamily(modelKey);
  const strippedSlashFamily = slashFamily ? stripVariantSuffixes(slashFamily) : null;
  const slashFamilyLower = slashFamily?.toLowerCase();
  const strippedSlashFamilyLower = strippedSlashFamily?.toLowerCase();

  const add = (providerAlias: string, candidateModelKey: string): void => {
    matches.push({ providerAlias, modelKey: candidateModelKey });
  };

  if (strippedLower.startsWith('gemini-')) {
    add('google', stripped);
  }

  if (strippedLower.startsWith('claude-')) {
    add('anthropic', stripped);
  }

  if (providerAlias) {
    add(providerAlias, modelKey);
    if (strippedLower !== lower) add(providerAlias, stripped);
    if (slashFamily && slashFamilyLower !== lower) add(providerAlias, slashFamily);
    if (
      strippedSlashFamily &&
      strippedSlashFamilyLower !== slashFamilyLower &&
      strippedSlashFamilyLower !== lower
    ) {
      add(providerAlias, strippedSlashFamily);
    }
  }

  if (ownedBy) {
    add(ownedBy.toLowerCase(), modelKey);
    if (strippedLower !== lower) add(ownedBy.toLowerCase(), stripped);
    if (slashFamily && slashFamilyLower !== lower) add(ownedBy.toLowerCase(), slashFamily);
    if (
      strippedSlashFamily &&
      strippedSlashFamilyLower !== slashFamilyLower &&
      strippedSlashFamilyLower !== lower
    ) {
      add(ownedBy.toLowerCase(), strippedSlashFamily);
    }
  }

  if (lower.startsWith('claude-')) {
    add('anthropic', modelKey);
    if (strippedLower !== lower) add('anthropic', stripped);
  }

  if (lower.startsWith('gemini-')) {
    add('google', modelKey);
    if (strippedLower !== lower) add('google', stripped);
  }

  if (
    lower.startsWith('gpt-') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4') ||
    lower.startsWith('oai-') ||
    lower.startsWith('codex-') ||
    lower.startsWith('gpt-oss-')
  ) {
    add('openai', modelKey);
    if (strippedLower !== lower) add('openai', stripped);
    if (slashFamily && slashFamilyLower !== lower) add('openai', slashFamily);
    if (
      strippedSlashFamily &&
      strippedSlashFamilyLower !== slashFamilyLower &&
      strippedSlashFamilyLower !== lower
    ) {
      add('openai', strippedSlashFamily);
    }
  }

  return matches;
}

function extractSlashModelFamily(modelKey: string): string | null {
  const trimmed = modelKey.trim();
  if (!trimmed.includes('/')) return null;

  const segments = trimmed.split('/').filter((segment) => segment.trim() !== '');
  if (segments.length < 2) return null;

  return segments[segments.length - 1] ?? null;
}

function stripVariantSuffixes(modelKey: string): string {
  let normalized = modelKey;

  while (true) {
    const next = normalized
      .replace(/-(?:\d+(?:\.\d+)*)-(minimal|low|medium|high|max|xhigh|none)$/i, '')
      .replace(/-(thinking|reasoning)$/i, '')
      .replace(/-(minimal|low|medium|high|max|xhigh|none)$/i, '');

    if (next === normalized) {
      return next;
    }

    normalized = next;
  }
}

function applyConfiguredModelMetadata(
  models: OmniRouteModel[],
  config: OmniRouteConfig,
  modelsDevIndex: ModelsDevIndex | null,
): OmniRouteModel[] {
  const metadataConfig = config.modelMetadata;
  if (!metadataConfig) return models;

  let output = [...models];

  if (Array.isArray(metadataConfig)) {
    for (const block of metadataConfig) {
      const matcher = typeof block.match === 'string' ? block.match : coerceMatcherToRegExp(block.match);
      const metadata = metadataWithoutMatcher(block);
      if (typeof matcher === 'string') {
        const existingIndex = output.findIndex((model) => model.id === matcher);
        if (existingIndex >= 0) {
          output[existingIndex] = mergeModelMetadata(output[existingIndex], metadata);
        } else if (block.addIfMissing) {
          output.push(createSyntheticModel(matcher, metadata, modelsDevIndex, config));
        }
        continue;
      }

      if (!matcher) continue;
      output = output.map((model) => (matcher.test(model.id) ? mergeModelMetadata(model, metadata) : model));
    }

    return output;
  }

  for (const [modelId, metadata] of Object.entries(metadataConfig)) {
    const existingIndex = output.findIndex((model) => model.id === modelId);
    if (existingIndex >= 0) {
      output[existingIndex] = mergeModelMetadata(output[existingIndex], metadata);
    } else {
      output.push(createSyntheticModel(modelId, metadata, modelsDevIndex, config));
    }
  }

  return output;
}

function metadataFromModelsDev(model: ModelsDevModel): OmniRouteModelMetadata {
  return {
    ...(model.limit?.context !== undefined ? { contextWindow: model.limit.context } : {}),
    ...(model.limit?.output !== undefined ? { maxTokens: model.limit.output } : {}),
    ...(model.modalities?.input?.includes('image') ? { supportsVision: true } : {}),
    ...(model.tool_call === true ? { supportsTools: true } : {}),
    ...(model.reasoning === true ? { reasoning: true } : {}),
    supportsStreaming: true,
  };
}

function mergeModelMetadata(model: OmniRouteModel, metadata: OmniRouteModelMetadata): OmniRouteModel {
  return {
    ...model,
    ...(metadata.name !== undefined ? { name: metadata.name } : {}),
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(metadata.contextWindow !== undefined ? { contextWindow: metadata.contextWindow } : {}),
    ...(metadata.maxTokens !== undefined ? { maxTokens: metadata.maxTokens } : {}),
    ...(metadata.supportsStreaming !== undefined ? { supportsStreaming: metadata.supportsStreaming } : {}),
    ...(metadata.supportsVision !== undefined ? { supportsVision: metadata.supportsVision } : {}),
    ...(metadata.supportsTools !== undefined ? { supportsTools: metadata.supportsTools } : {}),
    ...(metadata.apiMode !== undefined ? { apiMode: metadata.apiMode } : {}),
    ...(metadata.reasoning !== undefined ? { reasoning: metadata.reasoning } : {}),
    ...(metadata.resetEmbeddedReasoningVariant !== undefined
      ? { resetEmbeddedReasoningVariant: metadata.resetEmbeddedReasoningVariant }
      : {}),
    ...(metadata.variants !== undefined ? { variants: metadata.variants } : {}),
    ...(metadata.pricing !== undefined ? { pricing: metadata.pricing } : {}),
  };
}

function metadataWithoutMatcher(block: OmniRouteModelMetadata & { match?: string | RegExp; addIfMissing?: boolean }): OmniRouteModelMetadata {
  const { match: _match, addIfMissing: _addIfMissing, ...metadata } = block;
  return metadata;
}

function createSyntheticModel(
  modelId: string,
  metadata: OmniRouteModelMetadata,
  modelsDevIndex: ModelsDevIndex | null,
  config: OmniRouteConfig,
): OmniRouteModel {
  const seed = modelsDevIndex
    ? applyModelsDevMetadata({ id: modelId, name: metadata.name || modelId }, config, modelsDevIndex)
    : ({ id: modelId, name: metadata.name || modelId } as OmniRouteModel);

  return mergeModelMetadata(seed, metadata);
}

function coerceMatcherToRegExp(value: unknown): RegExp | null {
  if (value instanceof RegExp) return value;
  return null;
}

/**
 * Split model ID for models.dev lookup
 */
function splitOmniRouteModelForLookup(
  modelId: string,
): { providerKey: string | null; modelKey: string } {
  const trimmed = modelId.trim();

  // Remove omniroute prefix if present
  const withoutPrefix = trimmed.replace(/^omniroute\//, '');

  // Split by /
  const parts = withoutPrefix.split('/').filter((p) => p.trim() !== '');

  if (parts.length >= 2) {
    return {
      providerKey: parts[0] ?? null,
      modelKey: parts.slice(1).join('/'),
    };
  }

  return { providerKey: null, modelKey: withoutPrefix };
}

/**
 * Resolve provider alias using config
 */
function resolveProviderAlias(
  providerKey: string | null,
  config: OmniRouteConfig,
): string | null {
  if (!providerKey) return null;

  const lower = providerKey.toLowerCase();

  // Default aliases
  const aliases: Record<string, string> = {
    oai: 'openai',
    openai: 'openai',
    cx: 'openai',
    codex: 'openai',
    antigravity: 'anthropic',
    anthropic: 'anthropic',
    claude: 'anthropic',
    gemini: 'google',
    google: 'google',
    deepseek: 'deepseek',
    mistral: 'mistral',
    xai: 'xai',
    groq: 'groq',
    together: 'together',
    openrouter: 'openrouter',
    perplexity: 'perplexity',
    cohere: 'cohere',
    ...config.modelsDev?.providerAliases,
  };

  return aliases[lower] ?? lower;
}
