import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import OmniRouteAuthPlugin from '../dist/index.js';
import { clearModelCache, clearModelsDevCache, fetchModels } from '../dist/runtime.js';

const ORIGINAL_FETCH = global.fetch;

function createEmptyOmniRouteFetch() {
  return async (input) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/combos')) {
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
}

afterEach(() => {
  clearModelCache();
  clearModelsDevCache();
  global.fetch = ORIGINAL_FETCH;
});

function createModelsResponse() {
  return {
    object: 'list',
    data: [
      {
        id: 'gpt-4.1-mini',
        name: 'GPT-4.1 Mini',
      },
    ],
  };
}

test('config hook applies defaults and normalized apiMode', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'invalid-mode',
        },
      },
    },
  };

  await plugin.config(config);

  assert.equal(config.provider.omniroute.api, 'chat');
  assert.equal(config.provider.omniroute.options.apiMode, 'chat');
  assert.equal(config.provider.omniroute.options.baseURL, 'http://localhost:20128/v1');
  assert.equal(config.provider.omniroute.npm, '@ai-sdk/openai-compatible');
  assert.equal(config.provider.omniroute.options.url, 'http://localhost:20128/v1');
});

test('config hook switches provider package and URL for responses mode', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
      },
    },
  };

  await plugin.config(config);

  assert.equal(config.provider.omniroute.api, 'responses');
  assert.equal(config.provider.omniroute.npm, '@ai-sdk/openai');
  assert.equal(config.provider.omniroute.options.url, 'http://localhost:20128/v1');
  assert.equal(config.provider.omniroute.models['gpt-4o'].api.npm, '@ai-sdk/openai');
  assert.equal(config.provider.omniroute.models['gpt-4o'].api.url, 'http://localhost:20128/v1');
});

test('responses mode preserves configured variants from provider options', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'gpt-4.1-mini': {
            name: 'GPT-4.1 Mini',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: false,
            },
            limit: {
              context: 128000,
              output: 16384,
            },
            variants: {
              low: { reasoningEffort: 'low', reasoning: { effort: 'low' } },
              medium: { reasoningEffort: 'medium', reasoning: { effort: 'medium' } },
              high: { reasoningEffort: 'high', reasoning: { effort: 'high' } },
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.deepEqual(config.provider.omniroute.models['gpt-4.1-mini'].variants, {
    low: { reasoningEffort: 'low', reasoning: { effort: 'low' } },
    medium: { reasoningEffort: 'medium', reasoning: { effort: 'medium' } },
    high: { reasoningEffort: 'high', reasoning: { effort: 'high' } },
  });
});

test('responses mode merges generated reasoning variants with explicit custom variants', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'codex/gpt-5.4': {
            name: 'Codex GPT-5.4',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: false,
            },
            limit: {
              context: 256000,
              output: 32000,
            },
            variants: {
              xhigh: { reasoningEffort: 'xhigh' },
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.deepEqual(config.provider.omniroute.models['codex/gpt-5.4'].variants, {
    low: { reasoningEffort: 'low' },
    medium: { reasoningEffort: 'medium' },
    high: { reasoningEffort: 'high' },
    xhigh: { reasoningEffort: 'xhigh' },
  });
});

test('responses mode exposes generated reasoning variants for reasoning-capable models', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'codex/gpt-5.4': {
            name: 'Codex GPT-5.4',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: false,
            },
            limit: {
              context: 256000,
              output: 32000,
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.deepEqual(config.provider.omniroute.models['codex/gpt-5.4'].variants, {
    low: { reasoningEffort: 'low' },
    medium: { reasoningEffort: 'medium' },
    high: { reasoningEffort: 'high' },
  });
});

test('resetEmbeddedReasoningVariant restores generated variants for embedded high suffix models', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  global.fetch = createEmptyOmniRouteFetch();

  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
          modelMetadata: {
            'antigravity/gemini-3.1-pro-high': {
              resetEmbeddedReasoningVariant: true,
              reasoning: true,
            },
          },
        },
        models: {
          'antigravity/gemini-3.1-pro-high': {
            name: 'Gemini 3.1 Pro High',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: true,
            },
            limit: {
              context: 1048576,
              output: 65535,
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.deepEqual(config.provider.omniroute.models['antigravity/gemini-3.1-pro-high'].options, {});
  assert.deepEqual(config.provider.omniroute.models['antigravity/gemini-3.1-pro-high'].variants, {
    low: { reasoningEffort: 'low' },
    medium: { reasoningEffort: 'medium' },
    high: { reasoningEffort: 'high' },
  });
});

test('embedded high suffix models keep fixed reasoning option by default', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  global.fetch = createEmptyOmniRouteFetch();

  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'antigravity/gemini-3.1-pro-high': {
            name: 'Gemini 3.1 Pro High',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: true,
            },
            limit: {
              context: 1048576,
              output: 65535,
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.deepEqual(config.provider.omniroute.models['antigravity/gemini-3.1-pro-high'].options, {
    reasoningEffort: 'high',
  });
  assert.deepEqual(config.provider.omniroute.models['antigravity/gemini-3.1-pro-high'].variants, {});
});

test('responses mode falls back anthropic-family models to chat provider runtime', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'antigravity/claude-opus-4-1': {
            name: 'Claude Opus 4.1',
            root: 'claude-opus-4-1-thinking',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: true,
            },
            limit: {
              context: 200000,
              output: 8192,
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.equal(config.provider.omniroute.models['antigravity/claude-opus-4-1'].api.npm, '@ai-sdk/openai-compatible');
  assert.equal(config.provider.omniroute.models['antigravity/claude-opus-4-1'].api.url, 'http://localhost:20128/v1');
});

test('responses mode falls back antigravity gemini models to chat provider runtime', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'antigravity/gemini-3.1-pro-high': {
            name: 'Gemini 3.1 Pro High',
            root: 'gemini-3.1-pro-high',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: true,
            },
            limit: {
              context: 1048576,
              output: 65535,
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.equal(config.provider.omniroute.models['antigravity/gemini-3.1-pro-high'].api.npm, '@ai-sdk/openai-compatible');
});

test('responses mode falls back mlx qwen models to chat provider runtime', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'mlx/mlx-community/Qwen3.5-4B-MLX-8bit': {
            name: 'Qwen3.5 4B MLX 8bit',
            capabilities: {
              reasoning: false,
              toolcall: true,
              attachment: false,
            },
            limit: {
              context: 32768,
              output: 4096,
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.equal(
    config.provider.omniroute.models['mlx/mlx-community/Qwen3.5-4B-MLX-8bit'].api.npm,
    '@ai-sdk/openai-compatible',
  );
});

test('per-model apiMode override forces chat runtime even when global mode is responses', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
          modelMetadata: {
            'minimax/minimax-m1': {
              apiMode: 'chat',
            },
          },
        },
        models: {
          'minimax/minimax-m1': {
            name: 'MiniMax M1',
            apiMode: 'chat',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: false,
            },
            limit: {
              context: 1000000,
              output: 8000,
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.equal(config.provider.omniroute.options.modelMetadata['minimax/minimax-m1'].apiMode, 'chat');
  assert.equal(config.provider.omniroute.models['minimax/minimax-m1'].api.npm, '@ai-sdk/openai-compatible');
});

test('per-model apiMode override can keep anthropic-family model on responses runtime', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
          modelMetadata: {
            'antigravity/claude-opus-4-1': {
              apiMode: 'responses',
            },
          },
        },
        models: {
          'antigravity/claude-opus-4-1': {
            name: 'Claude Opus 4.1',
            apiMode: 'responses',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: true,
            },
            limit: {
              context: 200000,
              output: 8192,
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.equal(config.provider.omniroute.options.modelMetadata['antigravity/claude-opus-4-1'].apiMode, 'responses');
  assert.equal(config.provider.omniroute.models['antigravity/claude-opus-4-1'].api.npm, '@ai-sdk/openai');
});

test('loader injects auth headers only for OmniRoute URLs', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const calls = [];

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });

    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'chat',
    },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [] }),
  });

  await interceptedFetch('https://example.com/not-omniroute', {
    method: 'POST',
    body: JSON.stringify({ value: true }),
  });

  const omnirouteCall = calls.find((call) => call.url.includes('/chat/completions'));
  const externalCall = calls.find((call) => call.url.includes('example.com/not-omniroute'));

  assert.ok(omnirouteCall);
  assert.ok(externalCall);

  const omnirouteHeaders = new Headers(omnirouteCall.init?.headers);
  assert.equal(omnirouteHeaders.get('Authorization'), 'Bearer secret-key');
  assert.equal(omnirouteHeaders.get('Content-Type'), 'application/json');

  const externalHeaders = new Headers(externalCall.init?.headers);
  assert.equal(externalHeaders.get('Authorization'), null);
});

test('loader exposes full responses endpoint URL in responses mode', async () => {
  const plugin = await OmniRouteAuthPlugin({});

  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'responses',
    },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);

  assert.equal(options.baseURL, 'http://localhost:20128/v1');
  assert.equal(options.url, 'http://localhost:20128/v1');
});

test('gemini tool schema payload is sanitized before forwarding', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  let forwardedBody;

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    forwardedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: { baseURL: 'http://localhost:20128/v1', apiMode: 'chat' },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gemini-2.5-pro',
      messages: [],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            parameters: {
              type: 'object',
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              additionalProperties: false,
              properties: {
                query: {
                  type: 'array',
                  items: {
                    $ref: '#/$defs/queryItem',
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      ],
    }),
  });

  assert.ok(forwardedBody);
  const params = forwardedBody.tools[0].functionDeclarations[0].parameters;
  assert.equal(params.$schema, undefined);
  assert.equal(params.additionalProperties, undefined);
  assert.equal(params.properties.query.items.$ref, undefined);
});

test('non-gemini payload keeps original tool schema fields', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  let forwardedBody;

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    forwardedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: { baseURL: 'http://localhost:20128/v1', apiMode: 'chat' },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            parameters: {
              type: 'object',
              $schema: 'https://json-schema.org/draft/2020-12/schema',
            },
          },
        },
      ],
    }),
  });

  assert.ok(forwardedBody);
  assert.equal(
    forwardedBody.tools[0].function.parameters.$schema,
    'https://json-schema.org/draft/2020-12/schema',
  );
});

test('gemini schema sanitization applies to responses endpoint request objects', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  let forwardedBody;

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = typeof init?.body === 'string' ? init.body : await input.clone().text();
    forwardedBody = JSON.parse(raw);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: { baseURL: 'http://localhost:20128/v1', apiMode: 'responses' },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  const request = new Request('http://localhost:20128/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-2.5-pro',
      input: 'test',
      tools: [
        {
          type: 'function',
          name: 'lookup',
          input_schema: {
            type: 'object',
            properties: {
              query: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
      ],
    }),
  });

  await interceptedFetch(request);

  assert.ok(forwardedBody);
  assert.equal(
    forwardedBody.tools[0].functionDeclarations[0].parameters.additionalProperties,
    undefined,
  );
  assert.equal(
    forwardedBody.tools[0].functionDeclarations[0].parameters.properties.query.items.additionalProperties,
    undefined,
  );
});

test('responses payload strips unsupported token limit fields', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  let forwardedBody;

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/combos')) {
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = typeof init?.body === 'string' ? init.body : await input.clone().text();
    forwardedBody = JSON.parse(raw);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: { baseURL: 'http://localhost:20128/v1', apiMode: 'responses' },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: 'test',
      max_output_tokens: 2048,
      max_tokens: 1024,
    }),
  });

  assert.ok(forwardedBody);
  assert.equal(forwardedBody.max_output_tokens, undefined);
  assert.equal(forwardedBody.max_tokens, undefined);
});

test('responses payload strips chat-only reasoning aliases but keeps reasoning object', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  let forwardedBody;

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/combos')) {
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = typeof init?.body === 'string' ? init.body : await input.clone().text();
    forwardedBody = JSON.parse(raw);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: { baseURL: 'http://localhost:20128/v1', apiMode: 'responses' },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: 'test',
      reasoningEffort: 'high',
      reasoning_effort: 'high',
      textVerbosity: 'medium',
      reasoning: { effort: 'high' },
    }),
  });

  assert.ok(forwardedBody);
  assert.equal(forwardedBody.reasoningEffort, undefined);
  assert.equal(forwardedBody.reasoning_effort, undefined);
  assert.equal(forwardedBody.textVerbosity, undefined);
  assert.deepEqual(forwardedBody.reasoning, { effort: 'high' });
});

test('responses payload converts reasoningEffort into reasoning object before cleanup', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  let forwardedBody;

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/combos')) {
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = typeof init?.body === 'string' ? init.body : await input.clone().text();
    forwardedBody = JSON.parse(raw);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: { baseURL: 'http://localhost:20128/v1', apiMode: 'responses' },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: 'test',
      reasoningEffort: 'medium',
    }),
  });

  assert.ok(forwardedBody);
  assert.equal(forwardedBody.reasoningEffort, undefined);
  assert.deepEqual(forwardedBody.reasoning, { effort: 'medium' });
});

test('models.dev enrichment matches antigravity claude variants to anthropic limits', async () => {
  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'antigravity/claude-opus-4-6-thinking',
            name: 'Claude Opus 4.6 Thinking',
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === 'https://models.dev/api.json') {
      return new Response(JSON.stringify({
        anthropic: {
          models: {
            'claude-opus-4-6': {
              limit: {
                context: 200000,
                output: 64000,
              },
              modalities: {
                input: ['text', 'image'],
              },
              tool_call: true,
              reasoning: true,
            },
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/combos')) {
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const models = await fetchModels({
    baseUrl: 'http://localhost:20128/v1',
    apiKey: 'secret-key',
    apiMode: 'chat',
    modelsDev: {
      enabled: true,
      url: 'https://models.dev/api.json',
      cacheTtl: 1,
    },
  }, 'secret-key', true);

  assert.equal(models[0].contextWindow, 200000);
  assert.equal(models[0].maxTokens, 64000);
  assert.equal(models[0].supportsVision, true);
});

test('models.dev enrichment matches antigravity gemini variants to google limits', async () => {
  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'antigravity/gemini-3.1-pro-high',
            name: 'Gemini 3.1 Pro High',
            root: 'gemini-3.1-pro-high',
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === 'https://models.dev/api.json') {
      return new Response(JSON.stringify({
        google: {
          models: {
            'gemini-3.1-pro': {
              limit: {
                context: 1048576,
                output: 65535,
              },
              modalities: {
                input: ['text', 'image'],
              },
              tool_call: true,
            },
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/combos')) {
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const models = await fetchModels({
    baseUrl: 'http://localhost:20128/v1',
    apiKey: 'secret-key',
    apiMode: 'chat',
    modelsDev: {
      enabled: true,
      url: 'https://models.dev/api.json',
      cacheTtl: 1,
    },
  }, 'secret-key', true);

  assert.equal(models[0].contextWindow, 1048576);
  assert.equal(models[0].maxTokens, 65535);
  assert.equal(models[0].supportsVision, true);
});

test('gemini payload preserves thought_signature for tool call parts', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  let forwardedBody;

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/combos')) {
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = typeof init?.body === 'string' ? init.body : await input.clone().text();
    forwardedBody = JSON.parse(raw);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: { baseURL: 'http://localhost:20128/v1', apiMode: 'chat' },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'antigravity/gemini-3.1-pro-high',
      tools: [
        {
          type: 'function',
          function: {
            name: 'default_api:bash',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        },
      ],
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCall: {
                toolName: 'default_api:bash',
                args: '{}',
                thoughtSignature: 'abc123',
              },
            },
          ],
        },
      ],
    }),
  });

  assert.equal(
    forwardedBody.messages[0].content[0].toolCall.thought_signature,
    'abc123',
  );
  assert.equal(forwardedBody.messages[0].content[0].thought_signature, 'abc123');
});

test('gemini payload copies thought_signature into input function call items', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  let forwardedBody;

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/combos')) {
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = typeof init?.body === 'string' ? init.body : await input.clone().text();
    forwardedBody = JSON.parse(raw);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: { baseURL: 'http://localhost:20128/v1', apiMode: 'chat' },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'antigravity/gemini-3.1-pro-high',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCall: {
                toolName: 'default_api:bash',
                args: '{}',
                thoughtSignature: 'sig-1',
              },
            },
          ],
        },
      ],
      input: [
        {
          type: 'function_call',
          name: 'default_api:bash',
          arguments: '{}',
        },
      ],
    }),
  });

  assert.equal(forwardedBody.input[0].thought_signature, 'sig-1');
});

test('gemini tools are wrapped as functionDeclarations', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  let forwardedBody;

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/combos')) {
      return new Response(JSON.stringify({ combos: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = typeof init?.body === 'string' ? init.body : await input.clone().text();
    forwardedBody = JSON.parse(raw);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: { baseURL: 'http://localhost:20128/v1', apiMode: 'chat' },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'antigravity/gemini-3.1-pro-high',
      tools: [
        {
          type: 'function',
          function: {
            name: 'default_api:bash',
            description: 'Run a bash command',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
    }),
  });

  assert.deepEqual(forwardedBody.tools, [
    {
      functionDeclarations: [
        {
          name: 'default_api:bash',
          description: 'Run a bash command',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
            required: ['command'],
          },
        },
      ],
    },
  ]);
});
