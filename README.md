# OpenCode OmniRoute Auth Plugin

OpenCode plugin for using **OmniRoute** as a first-class provider with:

- `/connect omniroute` auth flow
- dynamic `/v1/models` discovery
- OmniRoute-specific metadata enrichment
- safer combo model capability handling
- practical **Responses API** compatibility work for real OpenCode usage

This package is intentionally released separately because it goes beyond a minimal fork and tracks OmniRoute/OpenCode interoperability fixes faster.

## Why this package exists

If you only want a generic fork, the upstream/mainline style plugin may be enough.

This package exists for teams actually running OmniRoute in OpenCode and needing things that work in practice, not just on paper.

### What is different here

- **Real `apiMode: "responses"` wiring**
  - `chat` uses `@ai-sdk/openai-compatible`
  - `responses` uses `@ai-sdk/openai`
- **OmniRoute responses compatibility fixes**
  - normalizes/removes unsupported token limit fields on `/responses`
  - converts `reasoningEffort` aliases into `reasoning.effort`
- **Variant support for reasoning models**
  - keeps `low` / `medium` / `high`
  - merges generated variants with custom ones like `xhigh`
- **OmniRoute-aware model metadata enrichment**
  - `models.dev` enrichment for context/output limits
  - routed-provider matching using OmniRoute `root` / `owned_by` metadata
  - combo model lowest-common-capability calculation
- **Safer OpenCode runtime behavior**
  - provider bootstrap normalization
  - local/runtime testing focused on actual OpenCode behavior

### Why release it separately

Because OmniRoute behavior and OpenCode provider behavior do not always line up cleanly.

This package is for shipping OmniRoute-specific fixes without waiting for a generic upstream plugin direction, especially around:

- Responses API behavior
- reasoning variants
- custom/proxy provider quirks
- combo model metadata correctness

## Highlights

- ✅ `/connect omniroute` support
- ✅ API key authentication
- ✅ dynamic model fetching from `/v1/models`
- ✅ model caching with TTL
- ✅ fallback models when API/model listing fails
- ✅ combo model capability enrichment from `/api/combos`
- ✅ `chat` and `responses` runtime modes
- ✅ reasoning variant support for OmniRoute reasoning models
- ✅ request normalization for OmniRoute Responses API quirks
- ✅ routed model enrichment for Anthropic/Gemini families behind providers like `antigravity`

## Installation

```bash
npm install -g @riskihajar/opencode-omniroute-auth
```

Then add it to your OpenCode config:

```json
{
  "plugin": [
    "@riskihajar/opencode-omniroute-auth"
  ]
}
```

For local development you can also point OpenCode directly to the repository path:

```json
{
  "plugin": [
    "/absolute/path/to/opencode-omniroute-auth"
  ]
}
```

## Quick start

### 1. Connect

Run:

```bash
/connect omniroute
```

Then paste your OmniRoute API key.

### 2. Select model

Use:

```bash
/models
```

### 3. Done

The plugin will:

- register the `omniroute` provider
- fetch available models from OmniRoute
- enrich model metadata when possible
- inject auth headers for OmniRoute requests

## Configuration

Minimal example:

```json
{
  "plugin": [
    "@riskihajar/opencode-omniroute-auth"
  ],
  "provider": {
    "omniroute": {
      "options": {
        "baseURL": "http://localhost:20128/v1",
        "apiMode": "chat"
      }
    }
  }
}
```

### Options

| Option | Type | Description |
|---|---|---|
| `provider.omniroute.options.baseURL` | `string` | OmniRoute base URL. Default: `http://localhost:20128/v1` |
| `provider.omniroute.options.apiMode` | `'chat' \| 'responses'` | Runtime API mode. Default: `chat` |
| `provider.omniroute.options.refreshOnList` | `boolean` | Refresh model list on provider load. Default: `true` |
| `provider.omniroute.options.modelCacheTtl` | `number` | Cache TTL in ms |
| `provider.omniroute.options.modelsDev` | `object` | Configure models.dev enrichment |
| `provider.omniroute.options.modelMetadata` | `object \| array` | Override/add model metadata, including per-model `apiMode` |

## API modes

### `chat`

Uses:

- `@ai-sdk/openai-compatible`

Best when your OmniRoute/OpenCode flow is primarily Chat Completions compatible.

### `responses`

Uses:

- `@ai-sdk/openai`

This is important.

`responses` mode here is not just config decoration. It changes the runtime provider implementation so OpenCode can use native Responses API behavior.

Example:

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "apiMode": "responses"
      }
    }
  }
}
```

### Per-model `apiMode` override

Not every routed model behaves the same way behind OmniRoute.

Some models work best with Responses API, while others still stream in Chat Completions shape even when the provider is globally configured for `responses`.

Because of that, this plugin supports **per-model `apiMode` overrides**.

Example: keep global `responses`, but pin a specific model to `chat`:

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "apiMode": "responses",
        "modelMetadata": {
          "minimax/minimax-m1": {
            "apiMode": "chat"
          }
        }
      }
    }
  }
}
```

Example: force a specific model to stay on `responses`:

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "apiMode": "responses",
        "modelMetadata": {
          "some-provider/some-model": {
            "apiMode": "responses"
          }
        }
      }
    }
  }
}
```

You can also set `apiMode` directly inside `provider.omniroute.models` entries when you define custom seeded models.

By default, the plugin still applies a conservative fallback for known models that appear to break under Responses streaming, but an explicit per-model override wins.

Current built-in fallback behavior in global `responses` mode:

- Anthropic-family routed models such as Claude / Opus / Sonnet / Haiku fall back to `chat`
- Gemini-family routed models fall back to `chat`
- MLX/Qwen-style routed models such as `mlx/mlx-community/Qwen3.5-4B-MLX-8bit` fall back to `chat` when OmniRoute streams Chat Completions chunks on the Responses path
- suffixes like `-thinking`, `-reasoning`, `-high`, `-medium`, `-low`, `-minimal`, `-max`, `-xhigh`, and `-none` are normalized before that decision

This matters because some routed models may advertise support for both Chat Completions and Responses, but still emit `chat.completion.chunk` events when called through `/v1/responses`. In that case, the plugin prefers the safer `chat` runtime unless you explicitly override the model back to `responses`.

## Reasoning variants

For reasoning-capable models, this plugin can expose variants like:

- `low`
- `medium`
- `high`

and merge them with explicit model variants like:

- `xhigh`

This matters for OmniRoute/Codex-style models where upstream metadata is often incomplete or uneven.

## OmniRoute-specific behavior

### 1. Dynamic model fetching

Models are fetched from:

- `/v1/models`

### 2. Combo model enrichment

Combo models are resolved using OmniRoute combo metadata from:

- `/api/combos`

Capabilities are calculated conservatively using the lowest common denominator across resolvable backing models.

### 3. Responses API normalization

When using `apiMode: "responses"`, the plugin normalizes request payloads for OmniRoute quirks, including:

- removing unsupported token limit fields
- converting reasoning aliases into the shape expected by Responses requests

## models.dev enrichment

OmniRoute model listings do not always provide enough metadata for a good OpenCode UX.

This plugin can enrich models with data derived from `models.dev`, especially:

- context window
- output token limit
- tool support
- reasoning support

It also tries harder to resolve routed OmniRoute models by:

- checking the listed model `id`
- checking OmniRoute `root`
- normalizing runtime suffixes like `-thinking` or `-high`
- mapping routed provider aliases such as `antigravity` to the most likely upstream family when matching `models.dev`

Example:

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "modelsDev": {
          "enabled": true,
          "url": "https://models.dev/api.json",
          "timeoutMs": 1000,
          "cacheTtl": 86400000,
          "providerAliases": {
            "cx": "openai"
          }
        }
      }
    }
  }
}
```

## Custom model metadata

You can override or add model metadata manually.

JSON example:

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "modelMetadata": {
          "virtual/my-custom-model": {
            "contextWindow": 50000,
            "maxTokens": 2048,
            "apiMode": "chat"
          }
        }
      }
    }
  }
}
```

`opencode.js` example with matchers:

```js
{
  provider: {
    omniroute: {
      options: {
        modelMetadata: [
          { match: /gpt-5\.4/i, reasoning: true },
          { match: /gpt-5\.3-codex$/i, contextWindow: 200000, maxTokens: 8192 },
        ],
      },
    },
  },
}
```

## Runtime helpers

```ts
import {
  fetchModels,
  clearModelCache,
  refreshModels,
} from '@riskihajar/opencode-omniroute-auth/runtime';
```

## Development

```bash
npm install
npm test
```

## Release philosophy

This package is maintained as a pragmatic OmniRoute-focused distribution.

That means the priority order is:

1. make it work in real OpenCode setups
2. preserve OmniRoute-specific UX/features
3. keep the public package easy to consume

If upstream/fork-main behavior is too generic to solve OmniRoute edge cases quickly, this package will continue shipping targeted fixes independently.

## License

MIT
