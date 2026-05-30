# OpenCode OmniRoute Auth

<p align="center">
  <strong>OmniRoute provider plugin for OpenCode with real auth, dynamic models, Responses mode, Anthropic Messages routing, reasoning variants, and vision-aware metadata.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@riskihajar/opencode-omniroute-auth"><img alt="npm version" src="https://img.shields.io/npm/v/@riskihajar/opencode-omniroute-auth?style=for-the-badge&color=0f766e"></a>
  <a href="https://www.npmjs.com/package/@riskihajar/opencode-omniroute-auth"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@riskihajar/opencode-omniroute-auth?style=for-the-badge&color=0369a1"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@riskihajar/opencode-omniroute-auth?style=for-the-badge&color=52525b"></a>
  <img alt="node" src="https://img.shields.io/node/v/@riskihajar/opencode-omniroute-auth?style=for-the-badge&color=16a34a">
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=for-the-badge">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> -
  <a href="#api-modes">API Modes</a> -
  <a href="#configuration">Configuration</a> -
  <a href="#debugging">Debugging</a>
</p>

---

## What This Is

`@riskihajar/opencode-omniroute-auth` makes OmniRoute usable as a first-class OpenCode provider.

It is not just an API-key wrapper. The plugin patches the practical compatibility gaps between OpenCode, OmniRoute, OpenAI-compatible routes, Anthropic-compatible routes, Cursor Composer models, Responses API payloads, and incomplete model metadata.

## Highlights

| Area | What it does |
|---|---|
| Auth | Adds `/connect omniroute` and injects OmniRoute API keys safely. |
| Models | Fetches `/v1/models`, caches with TTL, supports fallback defaults. |
| Runtime modes | Supports `chat`, `responses`, and `anthropic`. |
| Anthropic path | Uses `@ai-sdk/anthropic` against OmniRoute `/v1/messages`. |
| Composer | Routes `cu/composer-2.5` through Anthropic Messages where tool calls work reliably. |
| Responses | Normalizes OpenCode/OpenAI payloads before forwarding to `/v1/responses`. |
| Reasoning | Adds reasoning variants and requests visible OpenAI/Codex reasoning summaries where supported. |
| Vision | Hydrates image capability for GPT-5/Codex-style routed models when metadata is incomplete. |
| Metadata | Enriches context, output, tools, reasoning, and image support from `models.dev`. |
| Combos | Optionally resolves OmniRoute `/api/combos` with conservative capability merging. |

## Install

```bash
npm install -g @riskihajar/opencode-omniroute-auth
```

Then install the OpenCode server and TUI entries:

```bash
npx @riskihajar/opencode-omniroute-auth install
```

The installer prompts for the OmniRoute `baseURL` and `apiMode`, prefilled from your
existing `opencode.json` (or `opencode.jsonc`) when present. Press Enter to accept the
defaults (`http://localhost:20128/v1`, `chat`, and OpenCode system prompt stripping
enabled). For unattended setups:

```bash
npx @riskihajar/opencode-omniroute-auth install \
  --base-url=http://192.168.1.10:20128/v1 \
  --api-mode=responses
# or accept whatever is already configured
npx @riskihajar/opencode-omniroute-auth install --yes
```

The installer creates `opencode.json` and `tui.json` if they do not exist, appends missing
plugin entries without duplicating existing ones, and updates `provider.omniroute.options`
with the values you confirmed. It detects `opencode.jsonc` / `tui.jsonc` and rewrites the
same file (note: comments are dropped on rewrite; the installer warns when this happens).

The TUI entry is written as the absolute path to the installed `dist/tui.js`. OpenCode
1.15.x's TUI plugin loader installs each entry through `npm install <spec>`, which fails on
subpath specs like `@riskihajar/opencode-omniroute-auth/tui` because npm treats the slash
as a local path. Using an absolute path skips that step and works on every platform. The
installer also migrates any legacy subpath entry from older installs.

Or add the plugin to your OpenCode config manually:

```json
{
  "plugin": [
    "@riskihajar/opencode-omniroute-auth"
  ]
}
```

For local development:

```json
{
  "plugin": [
    "/absolute/path/to/opencode-omniroute-auth"
  ]
}
```

## Quick Start

1. Start OmniRoute locally or point `baseURL` to your OmniRoute endpoint.
2. Run `/connect omniroute` inside OpenCode.
3. Paste your OmniRoute API key.
4. Pick a model from `/models`.
5. Run OpenCode with `omniroute/<model-id>`.

CLI example:

```bash
opencode run "explore project ini" --model omniroute/cu/composer-2.5
```

## Recommended Configs

### Balanced default

Use Chat Completions compatibility as the global default:

```json
{
  "plugin": ["@riskihajar/opencode-omniroute-auth"],
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

### Responses-first OpenAI/Codex setup

Use this when you want GPT/Codex-style models to go through Responses API:

```json
{
  "plugin": ["@riskihajar/opencode-omniroute-auth"],
  "provider": {
    "omniroute": {
      "options": {
        "baseURL": "http://localhost:20128/v1",
        "apiMode": "responses"
      }
    }
  }
}
```

In this mode the plugin still protects known non-Responses-safe models by switching them per-model to a safer runtime.

### Anthropic-first setup

Use this for Claude/Composer-style workloads through OmniRoute Messages API:

```json
{
  "plugin": ["@riskihajar/opencode-omniroute-auth"],
  "provider": {
    "omniroute": {
      "options": {
        "baseURL": "http://localhost:20128/v1",
        "apiMode": "anthropic"
      }
    }
  }
}
```

## API Modes

### `chat`

Uses `@ai-sdk/openai` against OmniRoute OpenAI-compatible chat routes.

Best for broadly compatible models and routes that stream `chat.completion.chunk` events.

### `responses`

Uses `@ai-sdk/openai` against OmniRoute `/v1/responses`.

The plugin normalizes payloads for real OmniRoute behavior:

- removes unsupported token limit fields from Responses requests
- strips rejected aliases such as `temperature`, `reasoning_summary`, `reasoning_effort`, and `textVerbosity`
- converts `reasoningEffort` into `reasoning.effort`
- preserves accepted Responses fields such as `store`, `prompt_cache_key`, `parallel_tool_calls`, `truncation`, `service_tier`, `metadata`, and `include`
- for OpenAI/Codex-like models, requests reasoning summary support with `reasoning.summary = "auto"` and `include = ["reasoning.encrypted_content"]`

Note: requesting reasoning summaries does not force OmniRoute/upstream to emit visible reasoning text. OpenCode can show `Thinking: ...` only when the stream contains the expected reasoning summary events.

### `anthropic`

Uses `@ai-sdk/anthropic` against OmniRoute `/v1/messages`.

This is the important path for Anthropic-family models and Cursor Composer models:

- sets both `api.npm` and `provider.npm` so OpenCode actually loads the Anthropic SDK
- sends Anthropic-compatible headers, including Claude Code and interleaved/fine-grained tool streaming betas
- sanitizes invalid empty SSE events such as `data: {}` before the Anthropic parser sees them
- preserves valid Anthropic message/content/tool/ping/error stream events
- supports Anthropic `thinking` payloads when OpenCode provides them
- defaults Composer tool-choice handling to `composer-any` for more reliable tool execution

## Automatic Runtime Routing

When global `apiMode` is `responses`, the plugin still makes per-model routing decisions where OmniRoute behavior is known to differ from the advertised mode.

| Model family | Runtime selected |
|---|---|
| OpenAI/Codex/GPT-style | `responses` unless overridden |
| Claude / Opus / Sonnet / Haiku | `anthropic` |
| `cu/composer-2.5` | `anthropic` |
| `cu/default` / `cursor/default` | `chat` |
| Gemini routed models | `chat` fallback |
| MLX/Qwen-style routed models | `chat` fallback |

Suffixes such as `-thinking`, `-reasoning`, `-high`, `-medium`, `-low`, `-minimal`, `-max`, `-xhigh`, and `-none` are normalized before routing decisions.

## Per-Model Overrides

Pin a model to a specific runtime when the default router is not what you want:

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "apiMode": "responses",
        "modelMetadata": {
          "minimax/minimax-m1": {
            "apiMode": "chat"
          },
          "some-provider/some-model": {
            "apiMode": "responses"
          }
        }
      }
    }
  }
}
```

Restore normal reasoning variant selection for models that already contain a suffix such as `-high`:

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

## Reasoning Support

For reasoning-capable models, the plugin can expose OpenCode variants such as:

- `low`
- `medium`
- `high`
- custom variants like `xhigh`

For Responses-mode OpenAI/Codex-like models, the plugin now also keeps OpenAI progress fields and asks for reasoning summary material in the shape OpenCode expects.

Expected outbound payload shape:

```json
{
  "model": "cx/gpt-5.5",
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  },
  "include": ["reasoning.encrypted_content"]
}
```

Important distinction:

- `tokens_reasoning > 0` means the model spent reasoning tokens.
- Visible `Thinking: ...` in OpenCode requires upstream stream events carrying reasoning summary text.
- If OmniRoute returns encrypted reasoning only, OpenCode may record reasoning tokens without showing summary text.

## Vision / Image Input

OmniRoute model listings often lack enough metadata for OpenCode to know whether a model accepts images. That can make OpenCode reject an image before the request is sent.

The plugin fixes this for supported GPT-5/Codex-style routed models by hydrating both metadata fields OpenCode checks:

- `capabilities.attachment = true`
- `modalities.input = ["text", "image"]`

Detection order:

1. explicit `provider.omniroute.options.modelMetadata`
2. OmniRoute model metadata from `/v1/models`
3. `models.dev` enrichment
4. conservative GPT-5/Codex-family fallback heuristics

If a model should stay text-only, pin it explicitly:

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

## models.dev Enrichment

The plugin can enrich OmniRoute models using `models.dev` data for:

- context window
- output token limit
- tool support
- reasoning support
- image support

It also resolves routed names more aggressively by checking model `id`, OmniRoute `root`, provider aliases, and normalized suffix-free names.

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
            "cx": "openai",
            "antigravity": "anthropic"
          }
        }
      }
    }
  }
}
```

## Combo Models

Combo model enrichment is available through OmniRoute `/api/combos`.

When enabled, the plugin calculates capabilities conservatively from backing models so OpenCode does not over-advertise tools, reasoning, or image support.

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "enableCombos": true
      }
    }
  }
}
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `baseURL` | `string` | `http://localhost:20128/v1` | OmniRoute base URL. |
| `apiMode` | `chat` \| `responses` \| `anthropic` | `chat` | Global runtime mode. |
| `anthropicToolChoice` | `auto` \| `composer-any` \| `any` | `composer-any` | Anthropic tool-choice policy. |
| `stripOpenCodeSystemPrompt` | `boolean` | `true` | Remove OpenCode's built-in system prompt before forwarding. |
| `refreshOnList` | `boolean` | `true` | Refresh models when provider is loaded. |
| `modelCacheTtl` | `number` | package default | Model cache TTL in milliseconds. |
| `modelsDev` | `object` | enabled defaults | Configure `models.dev` enrichment. |
| `modelMetadata` | `object` \| `array` | none | Manual metadata overrides and matchers. |
| `enableCombos` | `boolean` | `false` | Fetch and enrich OmniRoute combo models. |
| `enableFullGpt55Context` | `boolean` | `false` | Trust OmniRoute's advertised GPT-5.5 1M context instead of using the safer clamped budget. |

### OpenCode system prompt toggle

The plugin exposes `stripOpenCodeSystemPrompt` as a visible OpenCode TUI toggle when the
TUI subpath is enabled. OpenCode does not currently expose a dedicated plugin statusline
slot, so OmniRoute registers the status in the TUI footer slots (`home_footer` and
`sidebar_footer`) as:

```text
OmniRoute system prompt ON
```

Enable the server provider in `opencode.json`:

```json
{
  "plugin": [
    "@riskihajar/opencode-omniroute-auth"
  ]
}
```

Enable the visual TUI extension in `tui.json`. Use the installer:

```bash
npx @riskihajar/opencode-omniroute-auth install
```

This writes an absolute path entry, for example:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/usr/lib/node_modules/@riskihajar/opencode-omniroute-auth/dist/tui.js"
  ]
}
```

Do not edit `tui.json` to use the subpath spec `@riskihajar/opencode-omniroute-auth/tui`.
OpenCode 1.15.x's TUI loader runs `npm install <spec>` per entry, and npm cannot resolve
subpath specs as packages.

Use `ctrl+p` and select `OmniRoute system prompt: ON/OFF`, or use the TUI slash commands
`/omniroute-system-prompt-toggle`, `/omniroute-system-prompt-on`, and
`/omniroute-system-prompt-off`. These are TUI commands, not Markdown prompt commands. The
toggle writes:

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "stripOpenCodeSystemPrompt": true
      }
    }
  }
}
```

Restart OpenCode or reload the provider config after changing the flag so new requests use it.

## Custom Metadata

JSON config:

```json
{
  "provider": {
    "omniroute": {
      "options": {
        "modelMetadata": {
          "virtual/my-custom-model": {
            "contextWindow": 50000,
            "maxTokens": 2048,
            "apiMode": "chat",
            "reasoning": true,
            "supportsVision": false
          }
        }
      }
    }
  }
}
```

JavaScript config with matchers:

```js
export default {
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
};
```

## Runtime Helpers

```ts
import {
  fetchModels,
  clearModelCache,
  refreshModels,
} from '@riskihajar/opencode-omniroute-auth/runtime';
```

## Debugging

Inspect discovered provider models:

```bash
OMNIROUTE_PLUGIN_DEBUG=1 opencode models omniroute --print-logs --log-level DEBUG
```

Run a real Composer turn through OmniRoute:

```bash
OMNIROUTE_PLUGIN_DEBUG=1 opencode run "explore project ini" --model omniroute/cu/composer-2.5
```

Run a Responses-mode GPT/Codex turn:

```bash
OPENCODE_CONFIG_CONTENT='{"provider":{"omniroute":{"options":{"apiMode":"responses"}}}}' \
  OMNIROUTE_PLUGIN_DEBUG=1 \
  opencode run "jawab singkat: sebutkan 3 file utama project ini" --model omniroute/cx/gpt-5.5
```

Useful things to verify:

- the selected model uses the intended SDK/runtime (`@ai-sdk/openai` or `@ai-sdk/anthropic`)
- Composer calls use `/v1/messages`, not `/v1/responses`
- image-capable models expose `attachment=true` and `input.image=true`
- Responses payloads do not contain unsupported aliases rejected by OmniRoute
- reasoning text appears only when OmniRoute emits reasoning summary stream events

## Development

```bash
npm install
npm run build
npm test
```

Release preflight:

```bash
npm run prepublishOnly
```

## Why This Package Exists

OmniRoute and OpenCode both move fast, and provider behavior is not uniform across routed model families. This package ships targeted OmniRoute compatibility fixes without waiting for generic upstream plugin behavior to catch up.

Priority order:

1. real OpenCode behavior works
2. OmniRoute-specific UX is preserved
3. model metadata is conservative instead of misleading
4. public installation stays simple

## License

MIT
