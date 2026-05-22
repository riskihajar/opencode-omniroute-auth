import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  delete process.env.OPENCODE_AUTH_PATH;
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
  process.env.OPENCODE_AUTH_PATH = join(tmpdir(), 'missing-opencode-auth.json');
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        env: ['TEST_OMNIROUTE_API_KEY_DISABLED'],
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'invalid-mode',
        },
      },
    },
  };

  await plugin.config(config);

  assert.equal(config.provider.omniroute.api, 'http://localhost:20128/v1');
  assert.equal(config.provider.omniroute.options.apiMode, 'chat');
  assert.equal(config.provider.omniroute.options.baseURL, 'http://localhost:20128/v1');
  assert.equal(config.provider.omniroute.npm, '@ai-sdk/openai');
  assert.equal(config.provider.omniroute.options.url, 'http://localhost:20128/v1');
});

test('config hook switches provider package and URL for responses mode', async () => {
  process.env.OPENCODE_AUTH_PATH = join(tmpdir(), 'missing-opencode-auth.json');
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        env: ['TEST_OMNIROUTE_API_KEY_DISABLED'],
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
      },
    },
  };

  await plugin.config(config);

  assert.equal(config.provider.omniroute.api, 'http://localhost:20128/v1');
  assert.equal(config.provider.omniroute.npm, '@ai-sdk/openai');
  assert.equal(config.provider.omniroute.options.url, 'http://localhost:20128/v1');
  assert.equal(config.provider.omniroute.models['gpt-4o'].api.npm, '@ai-sdk/openai');
  assert.equal(config.provider.omniroute.models['gpt-4o'].api.url, 'http://localhost:20128/v1');
});

test('config hook supports Anthropic Messages mode', async () => {
  process.env.OPENCODE_AUTH_PATH = join(tmpdir(), 'missing-opencode-auth.json');
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        env: ['TEST_OMNIROUTE_API_KEY_DISABLED'],
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'anthropic',
        },
      },
    },
  };

  await plugin.config(config);

  assert.equal(config.provider.omniroute.api, 'http://localhost:20128/v1');
  assert.equal(config.provider.omniroute.npm, '@ai-sdk/anthropic');
  assert.equal(config.provider.omniroute.options.apiMode, 'anthropic');
  assert.equal(config.provider.omniroute.models['gpt-4o'].api.npm, '@ai-sdk/anthropic');
});

test('config hook eagerly hydrates OmniRoute models when API key env is available', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const previousApiKey = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = 'secret-key';

  try {
    global.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'codex/gpt-5.5',
              context_length: 1050000,
              max_input_tokens: 1050000,
              max_output_tokens: 128000,
              capabilities: {
                vision: true,
                tool_calling: true,
                reasoning: true,
              },
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
            },
            {
              id: 'glm/glm-5.1',
              context_length: 131072,
              max_output_tokens: 16384,
              capabilities: {
                tool_calling: true,
              },
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
          ],
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

      if (url === 'https://models.dev/api.json') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const config = {
      provider: {
        omniroute: {
          options: {
            baseURL: 'http://localhost:20128/v1',
            apiMode: 'responses',
            refreshOnList: true,
          },
        },
      },
    };

    await plugin.config(config);

    assert.deepEqual(config.provider.omniroute.models['codex/gpt-5.5'].limit, {
      context: 400000,
      input: 272000,
      output: 128000,
    });
    assert.equal(config.provider.omniroute.models['glm/glm-5.1'].limit.context, 131072);
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OMNIROUTE_API_KEY;
    } else {
      process.env.OMNIROUTE_API_KEY = previousApiKey;
    }
  }
});

test('config hook eagerly hydrates OmniRoute models using stored OpenCode auth without env', async () => {
  const previousApiKey = process.env.OMNIROUTE_API_KEY;
  delete process.env.OMNIROUTE_API_KEY;
  const tempDir = await mkdtemp(join(tmpdir(), 'opencode-auth-'));
  process.env.OPENCODE_AUTH_PATH = join(tempDir, 'auth.json');
  await writeFile(
    process.env.OPENCODE_AUTH_PATH,
    JSON.stringify({
      omniroute: {
        type: 'api',
        key: 'stored-secret-key',
      },
    }),
  );

  const plugin = await OmniRouteAuthPlugin({});

  try {
    global.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'glm/glm-5.1',
              context_length: 131072,
              max_output_tokens: 16384,
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://models.dev/api.json') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const config = {
      provider: {
        omniroute: {
          env: ['TEST_OMNIROUTE_API_KEY_DISABLED'],
          options: {
            baseURL: 'http://localhost:20128/v1',
            apiMode: 'responses',
          },
        },
      },
    };

    await plugin.config(config);

    assert.equal(config.provider.omniroute.models['glm/glm-5.1'].limit.context, 131072);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    if (previousApiKey === undefined) {
      delete process.env.OMNIROUTE_API_KEY;
    } else {
      process.env.OMNIROUTE_API_KEY = previousApiKey;
    }
  }
});

test('config hook reads OpenCode auth path override without requiring SDK provider calls', async () => {
  const previousApiKey = process.env.OMNIROUTE_API_KEY;
  delete process.env.OMNIROUTE_API_KEY;
  const tempDir = await mkdtemp(join(tmpdir(), 'opencode-auth-'));
  process.env.OPENCODE_AUTH_PATH = join(tempDir, 'auth.json');
  await writeFile(
    process.env.OPENCODE_AUTH_PATH,
    JSON.stringify({
      omniroute: {
        type: 'api',
        key: 'stored-secret-key',
      },
    }),
  );

  const plugin = await OmniRouteAuthPlugin({});

  try {
    global.fetch = createEmptyOmniRouteFetch();

    const config = {
      provider: {
        omniroute: {
          env: ['TEST_OMNIROUTE_API_KEY_DISABLED'],
          options: {
            baseURL: 'http://localhost:20128/v1',
            apiMode: 'responses',
          },
        },
      },
    };

    await plugin.config(config);

    assert.ok(config.provider.omniroute.models);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    if (previousApiKey === undefined) {
      delete process.env.OMNIROUTE_API_KEY;
    } else {
      process.env.OMNIROUTE_API_KEY = previousApiKey;
    }
  }
});

test('config hook clamps GPT-5.5 provider model config by default', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'cx/gpt-5.5-xhigh': {
            name: 'GPT-5.5 XHigh',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: true,
            },
            limit: {
              context: 1050000,
              input: 1050000,
              output: 128000,
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  assert.deepEqual(config.provider.omniroute.models['cx/gpt-5.5-xhigh'].limit, {
    context: 400000,
    input: 272000,
    output: 128000,
  });
});

test('loader clamps Codex GPT-5.5 routed limits to a realistic Plus-tier budget', async () => {
  const plugin = await OmniRouteAuthPlugin({});

  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'codex/gpt-5.5',
            context_length: 1050000,
            max_input_tokens: 1050000,
            max_output_tokens: 128000,
            capabilities: {
              vision: true,
              tool_calling: true,
              reasoning: true,
            },
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
        ],
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

  const provider = {
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'responses',
    },
  };

  await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);

  assert.deepEqual(provider.models['codex/gpt-5.5'].limit, {
    context: 400000,
    input: 272000,
    output: 128000,
  });
});

test('loader can preserve advertised GPT-5.5 routed 1M window when explicitly enabled', async () => {
  const plugin = await OmniRouteAuthPlugin({});

  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'codex/gpt-5.5',
            context_length: 1050000,
            max_input_tokens: 1050000,
            max_output_tokens: 128000,
            capabilities: {
              vision: true,
              tool_calling: true,
              reasoning: true,
            },
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
        ],
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

  const provider = {
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'responses',
      enableFullGpt55Context: true,
    },
  };

  await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);

  assert.deepEqual(provider.models['codex/gpt-5.5'].limit, {
    context: 1050000,
    input: 1050000,
    output: 128000,
  });
});

test('chat hooks add OpenAI-like session headers and Codex params', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const hookInput = {
    sessionID: 'session-123',
    agent: 'build',
    model: {
      id: 'codex/gpt-5.4',
      providerID: 'omniroute',
      api: {
        id: 'codex/gpt-5.4',
        url: 'http://localhost:20128/v1',
        npm: '@ai-sdk/openai',
      },
    },
    provider: {
      options: {
        apiMode: 'responses',
      },
    },
    message: {},
  };

  const headers = await plugin['chat.headers'](hookInput, {
    headers: {
      existing: 'kept',
    },
  });

  assert.deepEqual(headers.headers, {
    existing: 'kept',
    originator: 'opencode',
    session_id: 'session-123',
  });

  const params = await plugin['chat.params'](hookInput, {
    temperature: 0.5,
    topP: 1,
    maxOutputTokens: 32000,
    options: {
      previous: true,
    },
  });

  assert.equal(params.maxOutputTokens, undefined);
  assert.deepEqual(params.options, {
    previous: true,
    store: false,
    promptCacheKey: 'session-123',
  });
});

test('chat params hook leaves Anthropic routed models untouched in responses config', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const hookInput = {
    sessionID: 'session-123',
    agent: 'build',
    model: {
      id: 'cu/claude-4.6-sonnet-medium-thinking',
      providerID: 'omniroute',
      api: {
        id: 'cu/claude-4.6-sonnet-medium-thinking',
        url: 'http://localhost:20128/v1',
        npm: '@ai-sdk/anthropic',
      },
    },
    provider: {
      options: {
        apiMode: 'responses',
      },
    },
    message: {},
  };

  const params = await plugin['chat.params'](hookInput, {
    temperature: 0.5,
    topP: 1,
    maxOutputTokens: 32000,
    options: {
      previous: true,
    },
  });

  assert.deepEqual(params, {
    temperature: 0.5,
    topP: 1,
    maxOutputTokens: 32000,
    options: {
      previous: true,
    },
  });
});

test('chat message hook converts OpenCode agent mention to direct subtask', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const output = {
    parts: [
      {
        id: 'prt_user_text',
        sessionID: 'ses_123',
        messageID: 'msg_123',
        type: 'text',
        text: '@explore cek project ini',
      },
      {
        id: 'prt_agent',
        sessionID: 'ses_123',
        messageID: 'msg_123',
        type: 'agent',
        name: 'explore',
        source: {
          value: '@explore',
          start: 0,
          end: 8,
        },
      },
      {
        id: 'prt_synthetic',
        sessionID: 'ses_123',
        messageID: 'msg_123',
        type: 'text',
        synthetic: true,
        text: [
          'Use the above message and context to generate a prompt',
          'and call the task tool with subagent: explore',
        ].join(' '),
      },
    ],
  };

  await plugin['chat.message'](
    {
      model: {
        providerID: 'omniroute',
        modelID: 'cu/composer-2.5',
      },
    },
    output,
  );

  const subtask = output.parts.find((part) => part.type === 'subtask');
  assert.ok(subtask);
  assert.equal(subtask.agent, 'explore');
  assert.equal(subtask.description, 'explore task');
  assert.equal(subtask.prompt, 'cek project ini');
  assert.equal(output.parts.some((part) => part.synthetic === true), false);
  assert.equal(output.parts.some((part) => part.type === 'agent'), false);
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
    low: {
      reasoningEffort: 'low',
      reasoningSummary: 'auto',
      include: ['reasoning.encrypted_content'],
    },
    medium: {
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      include: ['reasoning.encrypted_content'],
    },
    high: {
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
      include: ['reasoning.encrypted_content'],
    },
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
    low: {
      reasoningEffort: 'low',
      reasoningSummary: 'auto',
      include: ['reasoning.encrypted_content'],
    },
    medium: {
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      include: ['reasoning.encrypted_content'],
    },
    high: {
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
      include: ['reasoning.encrypted_content'],
    },
    xhigh: {
      reasoningEffort: 'xhigh',
      reasoningSummary: 'auto',
      include: ['reasoning.encrypted_content'],
    },
  });
});

test('responses mode generates xhigh variant for GPT-5.5 routed models', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'cx/gpt-5.5': {
            name: 'GPT-5.5',
            capabilities: {
              toolcall: true,
              attachment: true,
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

  assert.deepEqual(config.provider.omniroute.models['cx/gpt-5.5'].variants.xhigh, {
    reasoningEffort: 'xhigh',
    reasoningSummary: 'auto',
    include: ['reasoning.encrypted_content'],
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

test('responses mode routes anthropic-family models to Anthropic Messages runtime', async () => {
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

  assert.equal(
    config.provider.omniroute.models['antigravity/claude-opus-4-1'].api.npm,
    '@ai-sdk/anthropic',
  );
  assert.equal(
    config.provider.omniroute.models['antigravity/claude-opus-4-1'].provider.npm,
    '@ai-sdk/anthropic',
  );
  assert.equal(
    config.provider.omniroute.models['antigravity/claude-opus-4-1'].api.url,
    'http://localhost:20128/v1',
  );
});

test('responses mode routes Cursor Composer to Anthropic Messages runtime', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'cu/composer-2.5': {
            name: 'Composer 2.5',
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

  const model = config.provider.omniroute.models['cu/composer-2.5'];
  assert.equal(model.api.npm, '@ai-sdk/anthropic');
  assert.equal(model.provider.npm, '@ai-sdk/anthropic');
  assert.equal(model.api.url, 'http://localhost:20128/v1');
  assert.equal(model.provider.api, 'http://localhost:20128/v1');
  assert.equal(model.capabilities.reasoning, true);
  assert.deepEqual(model.options, {});
});

test('cursor-routed Claude thinking models do not receive OpenAI reasoning options', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: 'http://localhost:20128/v1',
          apiMode: 'responses',
        },
        models: {
          'cu/claude-4.6-sonnet-medium-thinking': {
            name: 'Claude 4.6 Sonnet Medium Thinking',
            capabilities: {
              reasoning: true,
              toolcall: true,
              attachment: true,
            },
            limit: {
              context: 200000,
              output: 64000,
            },
          },
        },
      },
    },
  };

  await plugin.config(config);

  const model = config.provider.omniroute.models['cu/claude-4.6-sonnet-medium-thinking'];
  assert.equal(model.api.npm, '@ai-sdk/anthropic');
  assert.equal(model.capabilities.reasoning, false);
  assert.deepEqual(model.options, {});
  assert.deepEqual(model.variants, {});
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

  assert.equal(config.provider.omniroute.models['antigravity/gemini-3.1-pro-high'].api.npm, '@ai-sdk/openai');
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
    '@ai-sdk/openai',
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
  assert.equal(config.provider.omniroute.models['minimax/minimax-m1'].api.npm, '@ai-sdk/openai');
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

test('loader adds Anthropic-compatible API key header for messages endpoint', async () => {
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
      apiMode: 'anthropic',
    },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'cu/claude-4.6-sonnet-medium-thinking', messages: [] }),
  });

  const messagesCall = calls.find((call) => call.url.endsWith('/v1/messages'));
  assert.ok(messagesCall);

  const headers = new Headers(messagesCall.init?.headers);
  assert.equal(headers.get('Authorization'), 'Bearer secret-key');
  assert.equal(headers.get('x-api-key'), 'secret-key');
  assert.equal(headers.get('Content-Type'), 'application/json');
});

test('loader drops invalid empty Anthropic SSE events from messages stream', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"cx/gpt-5.5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
    'event: ping',
    'data: {}',
    '',
    'data: {}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  const provider = {
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'anthropic',
    },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  const response = await interceptedFetch('http://localhost:20128/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'cx/gpt-5.5', messages: [], stream: true }),
  });
  const text = await response.text();

  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  assert.match(text, /"type":"message_start"/);
  assert.match(text, /"type":"content_block_delta"/);
  assert.doesNotMatch(text, /data: \{\}/);
});

test('loader does not sanitize non-messages event streams', async () => {
  const plugin = await OmniRouteAuthPlugin({});

  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('data: {}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  const provider = {
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'anthropic',
    },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  const response = await interceptedFetch('http://localhost:20128/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [], stream: true }),
  });

  assert.equal(await response.text(), 'data: {}\n\n');
});

test('loader forces task tool for OpenCode agent mentions on Anthropic messages', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const forwardedBodies = [];

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = typeof init?.body === 'string' ? init.body : await input.clone().text();
    forwardedBodies.push(JSON.parse(raw));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'anthropic',
    },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'cu/composer-2.5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '@explore ' },
            {
              type: 'text',
              text: [
                'Use the above message and context to generate a prompt',
                'and call the task tool with subagent: explore',
              ].join(' '),
            },
          ],
        },
      ],
      tools: [
        {
          name: 'task',
          input_schema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }),
  });

  assert.deepEqual(forwardedBodies.at(-1).tool_choice, {
    type: 'tool',
    name: 'task',
  });
});

test('loader forces a starter Anthropic tool for Cursor Composer exploration prompts', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  let forwardedBody;
  let forwardedHeaders;

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = typeof init?.body === 'string' ? init.body : await input.clone().text();
    forwardedHeaders = new Headers(init?.headers);
    forwardedBody = JSON.parse(raw);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'anthropic',
    },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'cu/composer-2.5',
      messages: [
        {
          role: 'user',
          content: 'explore project ini',
        },
      ],
      tools: [
        {
          name: 'read',
          input_schema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
            },
          },
        },
        {
          name: 'grep',
          input_schema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
            },
          },
        },
      ],
    }),
  });

  assert.deepEqual(forwardedBody.tool_choice, {
    type: 'tool',
    name: 'read',
  });
  assert.equal(
    forwardedHeaders.get('anthropic-beta'),
    'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
  );
  assert.equal(forwardedHeaders.get('x-api-key'), 'secret-key');
  assert.match(forwardedBody.messages[0].content, /explore project ini/);
  assert.match(forwardedBody.messages[0].content, /call the read tool first/);
});

test('loader forces generic Anthropic tool use for Cursor Composer when tools exist', async () => {
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
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'anthropic',
    },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'cu/composer-2.5',
      messages: [
        {
          role: 'user',
          content: 'implement fitur kecil',
        },
      ],
      tools: [
        {
          name: 'read',
          input_schema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
            },
          },
        },
      ],
    }),
  });

  assert.deepEqual(forwardedBody.tool_choice, {
    type: 'any',
  });
});

test('loader can leave generic Anthropic tool choice on auto by config', async () => {
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
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'anthropic',
      anthropicToolChoice: 'auto',
    },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;

  await interceptedFetch('http://localhost:20128/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'cu/composer-2.5',
      messages: [
        {
          role: 'user',
          content: 'explore project ini',
        },
      ],
      tools: [
        {
          name: 'read',
          input_schema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
            },
          },
        },
      ],
    }),
  });

  assert.equal(forwardedBody.tool_choice, undefined);
});

test('loader preserves explicit Anthropic tool choice and forces tools with thinking settings', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const forwardedBodies = [];

  global.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(createModelsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = typeof init?.body === 'string' ? init.body : await input.clone().text();
    forwardedBodies.push(JSON.parse(raw));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = {
    options: {
      baseURL: 'http://localhost:20128/v1',
      apiMode: 'anthropic',
    },
    models: {},
  };

  const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
  const interceptedFetch = options.fetch;
  const basePayload = {
    model: 'cu/composer-2.5',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'call the task tool with subagent: explore',
          },
        ],
      },
    ],
    tools: [
      {
        name: 'task',
        input_schema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };

  await interceptedFetch('http://localhost:20128/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      ...basePayload,
      tool_choice: { type: 'none' },
    }),
  });

  await interceptedFetch('http://localhost:20128/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      ...basePayload,
      thinking: { type: 'enabled', budget_tokens: 1024 },
    }),
  });

  assert.deepEqual(forwardedBodies[0].tool_choice, { type: 'none' });
  assert.deepEqual(forwardedBodies[1].tool_choice, {
    type: 'tool',
    name: 'task',
  });
  assert.deepEqual(forwardedBodies[1].thinking, { type: 'enabled', budget_tokens: 1024 });
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

test('responses payload strips temperature but chat completions keep it', async () => {
  const plugin = await OmniRouteAuthPlugin({});
  const forwardedBodies = [];

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
    forwardedBodies.push({ url, body: JSON.parse(raw) });
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
      model: 'codex/gpt-5.4',
      input: 'test',
      temperature: 0.5,
    }),
  });

  await interceptedFetch('http://localhost:20128/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'codex/gpt-5.4',
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0.5,
    }),
  });

  const responsesCall = forwardedBodies.find((entry) => entry.url.endsWith('/v1/responses'));
  const chatCall = forwardedBodies.find((entry) => entry.url.endsWith('/v1/chat/completions'));

  assert.ok(responsesCall);
  assert.ok(chatCall);
  assert.equal(responsesCall.body.temperature, undefined);
  assert.equal(chatCall.body.temperature, 0.5);
});

test('chat payload strips unsupported reasoning summary aliases', async () => {
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
      model: 'codex/gpt-5.4',
      messages: [{ role: 'user', content: 'test' }],
      reasoningSummary: 'detailed',
      reasoning_summary: 'concise',
      textVerbosity: 'medium',
      reasoningEffort: 'high',
    }),
  });

  assert.ok(forwardedBody);
  assert.equal(forwardedBody.reasoningSummary, undefined);
  assert.equal(forwardedBody.reasoning_summary, undefined);
  assert.equal(forwardedBody.textVerbosity, 'medium');
  assert.equal(forwardedBody.reasoningEffort, undefined);
  assert.deepEqual(forwardedBody.reasoning, { effort: 'high' });
});

test('chat payload converts input-shaped bodies into messages', async () => {
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
      model: 'codex/gpt-5.4',
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'Say OK only.' }],
      }],
      reasoningSummary: 'auto',
    }),
  });

  assert.ok(forwardedBody);
  assert.equal(forwardedBody.input, undefined);
  assert.ok(Array.isArray(forwardedBody.messages));
  assert.deepEqual(forwardedBody.messages.at(-1), { role: 'user', content: 'Say OK only.' });
  assert.equal(forwardedBody.messages[0].role, 'system');
  assert.equal(forwardedBody.reasoningSummary, undefined);
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

test('responses payload keeps OpenAI progress fields for Codex-style models', async () => {
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
      model: 'codex/gpt-5.4',
      input: 'test',
      reasoningSummary: 'detailed',
      reasoning_summary: 'concise',
      reasoning: { effort: 'high' },
    }),
  });

  assert.ok(forwardedBody);
  assert.equal(forwardedBody.reasoningSummary, 'detailed');
  assert.equal(forwardedBody.reasoning_summary, undefined);
  assert.deepEqual(forwardedBody.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(forwardedBody.include, ['reasoning.encrypted_content']);
});

test('responses payload requests reasoning summary text for Codex-style models by default', async () => {
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
      model: 'cx/gpt-5.5',
      input: 'test',
    }),
  });

  assert.ok(forwardedBody);
  assert.deepEqual(forwardedBody.reasoning, { effort: 'medium', summary: 'auto' });
  assert.deepEqual(forwardedBody.include, ['reasoning.encrypted_content']);
});

test('responses payload appends reasoning encrypted content include for Codex-style models', async () => {
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
      model: 'codex/gpt-5.4',
      input: 'test',
      reasoning: { effort: 'high', summary: 'detailed' },
      include: ['file_search_call.results'],
    }),
  });

  assert.ok(forwardedBody);
  assert.deepEqual(forwardedBody.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(forwardedBody.include, [
    'file_search_call.results',
    'reasoning.encrypted_content',
  ]);
});

test('responses payload keeps OmniRoute-supported responses fields', async () => {
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
      model: 'codex/gpt-5.4',
      input: 'test',
      store: false,
      prompt_cache_key: 'cache-key',
      parallel_tool_calls: true,
      truncation: 'auto',
      service_tier: 'auto',
      top_p: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      metadata: { source: 'test' },
      include: ['reasoning.encrypted_content'],
    }),
  });

  assert.ok(forwardedBody);
  assert.equal(forwardedBody.store, false);
  assert.equal(forwardedBody.prompt_cache_key, 'cache-key');
  assert.equal(forwardedBody.parallel_tool_calls, true);
  assert.equal(forwardedBody.truncation, 'auto');
  assert.equal(forwardedBody.service_tier, 'auto');
  assert.equal(forwardedBody.top_p, 1);
  assert.equal(forwardedBody.presence_penalty, 0);
  assert.equal(forwardedBody.frequency_penalty, 0);
  assert.deepEqual(forwardedBody.metadata, { source: 'test' });
  assert.deepEqual(forwardedBody.include, ['reasoning.encrypted_content']);
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
