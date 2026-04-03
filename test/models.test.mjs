import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearModelCache,
  fetchModels,
  getCachedModels,
  isCacheValid,
  refreshModels,
} from '../dist/runtime.js';

const ORIGINAL_FETCH = global.fetch;

const CONFIG = {
  baseUrl: 'http://localhost:20128/v1',
  apiKey: 'test-key',
  apiMode: 'chat',
  modelCacheTtl: 60000,
  modelsDev: { enabled: false },
};

afterEach(() => {
  clearModelCache();
  global.fetch = ORIGINAL_FETCH;
});

test('fetchModels caches successful responses', async () => {
  let calls = 0;

  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/api/combos')) {
      calls += 1;
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    calls += 1;
    return new Response(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' }],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  const first = await fetchModels(CONFIG, CONFIG.apiKey, false);
  const second = await fetchModels(CONFIG, CONFIG.apiKey, false);

  assert.equal(calls, 2);
  assert.equal(first[0].id, 'gpt-4.1-mini');
  assert.equal(second[0].id, 'gpt-4.1-mini');
  assert.ok(getCachedModels(CONFIG, CONFIG.apiKey));
  assert.equal(isCacheValid(CONFIG, CONFIG.apiKey), true);
});

test('refreshModels forces refetch', async () => {
  let calls = 0;

  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/api/combos')) {
      calls += 1;
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    calls += 1;
    return new Response(
      JSON.stringify({
        object: 'list',
        data: [{ id: `model-${calls}`, name: `Model ${calls}` }],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  await fetchModels(CONFIG, CONFIG.apiKey, false);
  const refreshed = await refreshModels(CONFIG, CONFIG.apiKey);

  assert.equal(calls, 4);
  assert.equal(refreshed[0].id, 'model-3');
});

test('fetchModels falls back to defaults when response shape is invalid', async () => {
  global.fetch = async () => {
    return new Response(JSON.stringify({ data: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const models = await fetchModels(CONFIG, CONFIG.apiKey, true);
  assert.ok(models.length > 0);
  assert.ok(typeof models[0].id === 'string');
});
