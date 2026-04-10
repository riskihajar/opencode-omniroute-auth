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
  - `chat` uses `@ai-sdk/openai`
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
- ✅ image capability hydration for GPT-5/Codex-style routed models

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

## Vision / image input

### Pain point this plugin fixes

OmniRoute model listings from `/v1/models` often do not include enough capability metadata for OpenCode to know whether a model supports image input.

In practice that can cause a bad failure mode for image prompts:

- OpenCode renders the dropped image as `[Image 1]`
- the provider registry thinks the selected model is text-only
- the image attachment is rejected before the request is sent
- OpenCode injects an error message into the user payload instead of sending `input_image`

That degraded payload looks like this:

```json
{
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "[Image 1] ini gambar apa?"
    },
    {
      "type": "input_text",
      "text": "ERROR: Cannot read \"MAP-Midtrans-04-04-2026_10_14_PM.png\" (this model does not support image input). Inform the user."
    }
  ]
}
```

This plugin now fixes that for supported GPT-5/Codex-style OmniRoute models by keeping image capability hydration stable across provider bootstrap and runtime refresh.

### How image capability is detected

The plugin decides image support in this order:

1. explicit `provider.omniroute.options.modelMetadata`
2. OmniRoute/runtime metadata when available
3. `models.dev` enrichment when available
4. conservative GPT-5/Codex-family fallback heuristics for known routed model families

If a model is considered vision-capable, the provider model now exposes both:

- `capabilities.attachment = true`
- `modalities.input = ['text', 'image']`

That combination is important because OpenCode uses provider capability metadata before deciding whether to serialize a dropped/pasted image as `input_image`.

### How to confirm it works

When image handling works, your request payload should contain a real image part, not just an injected error string:

```json
{
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "[Image 1] gambar apa yok?"
    },
    {
      "type": "input_image",
      "image_url": "data:image/png;base64,..."
    }
  ]
}
```

### If a model truly does not support image input

The plugin prefers explicit metadata over heuristics.

- If OmniRoute or your manual `modelMetadata` says a model does not support image input, that model should remain text-only.
- If metadata is missing, the plugin only enables image support for known GPT-5/Codex-style families where real-world OpenCode usage would otherwise degrade badly.
- Everything else stays on the safe default unless explicit metadata or enrichment says otherwise.

If you know a routed model should stay text-only, pin it explicitly:

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "modelMetadata": {
          "some-provider/some-text-only-model": {
            "supportsVision": false
          }
        }
      }
    }
  }
}
```

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
| `provider.omniroute.options.modelMetadata` | `object \| array` | Override/add model metadata, including per-model `apiMode` and `resetEmbeddedReasoningVariant` |

## API modes

### `chat`

Uses:

- `@ai-sdk/openai`

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

If a routed model id already ends with an embedded reasoning suffix like `-high` or `-low`, you can clear that forced winner override and restore the normal variant picker with `resetEmbeddedReasoningVariant: true`.

Example:

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "modelMetadata": {
          "antigravity/gemini-3.1-pro-high": {
            "resetEmbeddedReasoningVariant": true,
            "reasoning": true
          }
        }
      }
    }
  }
}
```

By default, the plugin still applies a conservative fallback for known models that appear to break under Responses streaming, but an explicit per-model override wins.

Current built-in fallback behavior in global `responses` mode:

- Cursor default aliases `cu/default` and `cursor/default` fall back to `chat`
- Anthropic-family routed models such as Claude / Opus / Sonnet / Haiku fall back to `chat`
- Gemini-family routed models fall back to `chat`
- MLX/Qwen-style routed models such as `mlx/mlx-community/Qwen3.5-4B-MLX-8bit` fall back to `chat` when OmniRoute streams Chat Completions chunks on the Responses path
- suffixes like `-thinking`, `-reasoning`, `-high`, `-medium`, `-low`, `-minimal`, `-max`, `-xhigh`, and `-none` are normalized before that decision

This matters because some routed models may advertise support for both Chat Completions and Responses, but still emit `chat.completion.chunk` events when called through `/v1/responses`. In that case, the plugin prefers the safer `chat` runtime unless you explicitly override the model back to `responses`.

For Cursor specifically:

- `cu/default` and `cursor/default` are forced to `chat` because OmniRoute currently returns Chat Completions streaming there even when OpenCode is globally configured for `responses`
- Cursor-routed Claude models continue to follow the existing Claude-family fallback behavior instead of getting a broader Cursor-wide special case

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
- stripping OpenCode/OpenAI-style aliases that OmniRoute currently rejects on `/v1/responses`, including `temperature`, `reasoningSummary`, `reasoning_summary`, `reasoningEffort`, `reasoning_effort`, and `textVerbosity`

This plugin intentionally stays on `@ai-sdk/openai` for both Chat and Responses modes and treats OmniRoute compatibility as a payload-shaping problem rather than relying on a separate OpenAI-compatible runtime.

For the current OmniRoute behavior tested locally, the plugin preserves Responses fields that are accepted for Codex/GPT-5-style models, including:

- `store`
- `prompt_cache_key`
- `parallel_tool_calls`
- `truncation`
- `service_tier`
- `top_p`
- `presence_penalty`
- `frequency_penalty`
- `metadata`
- `include`

## models.dev enrichment

OmniRoute model listings do not always provide enough metadata for a good OpenCode UX.

This plugin can enrich models with data derived from `models.dev`, especially:

- context window
- output token limit
- tool support
- reasoning support
- image support when `modalities.input` includes `image`

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

## Debugging and self-test

### Check discovered models

To inspect the OmniRoute provider model registry with debug logs enabled:

```bash
source ~/.zshrc && OMNIROUTE_PLUGIN_DEBUG=1 opencode models omniroute --print-logs --log-level DEBUG
```

Useful things to verify in the output:

- `Hydrated model codex/gpt-5.4: attachment=true input.image=true toolcall=true`
- no later hydration pass flipping the same model back to `attachment=false`
- `omniroute/cu/default` and `omniroute/cursor/default` should resolve without Responses parser errors

### Spawn OpenCode for a quick self-test

To reproduce image handling from the CLI:

```bash
source ~/.zshrc && OMNIROUTE_PLUGIN_DEBUG=1 opencode run --model omniroute/codex/gpt-5.4 "[Image 1] ini gambar apa?" --print-logs --log-level DEBUG
```

What to look for:

- if OpenCode still blocks image input before request serialization, your payload will degrade into injected `input_text` error content
- if image serialization works, the user payload should contain `type: "input_image"`

### Common verification flow

1. restart OpenCode completely after plugin changes
2. run `opencode models omniroute --print-logs --log-level DEBUG`
3. confirm the target model is hydrated with `attachment=true`
4. drop or paste an image into a fresh session
5. inspect the payload and confirm `input_image` is present

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
