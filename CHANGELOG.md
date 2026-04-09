# Changelog

All notable changes to this project are documented in this file.

## [1.2.8] - 2026-04-09

### Added

- Added `resetEmbeddedReasoningVariant` metadata support so routed model IDs like `antigravity/gemini-3.1-pro-high` can opt back into normal OpenCode reasoning variants.
- Added regression coverage for embedded reasoning suffix resets, default fixed-suffix behavior, and Responses-vs-Chat temperature handling.

### Changed

- Updated README with configuration guidance for `resetEmbeddedReasoningVariant` when using `modelMetadata` or seeded provider models.

### Fixed

- Fixed provider model metadata merging so explicit `modelMetadata` overrides are preserved instead of being overwritten by seeded model-derived metadata.
- Fixed Responses payload normalization to strip `temperature`, matching OmniRoute's current Responses behavior while leaving Chat Completions payloads unchanged.
- Fixed `models.dev` enrichment for Gemini routed IDs with embedded reasoning/version suffixes so upstream Google model limits still hydrate correctly.

### Verification

- Verified `codex/gpt-5.4` accepts `temperature` on `/v1/chat/completions` but rejects it on `/v1/responses`, and covered the plugin workaround with tests.
- Verified `npm test` passes with regression coverage for embedded reasoning reset and Responses payload sanitization.

## [1.2.7] - 2026-04-05

### Changed

- Updated README troubleshooting and API mode guidance to document Cursor default alias fallback behavior.

### Fixed

- Fixed `cu/default` and `cursor/default` being sent through the Responses runtime even when OmniRoute streamed Chat Completions chunks for those aliases.
- Narrowed the Cursor-specific runtime fallback so it only targets the broken default aliases instead of broadly special-casing all `cu/*` and `cursor/*` models.

### Verification

- Verified `omniroute/cu/default` routes through `/v1/chat/completions` without Responses parser failures.
- Verified Cursor-routed Anthropic models such as `omniroute/cu/claude-4.5-sonnet` still complete successfully in OpenCode local testing.

## [1.2.6] - 2026-04-05

### Added

- Added provider `modalities` metadata so vision-capable OmniRoute models expose explicit `text` + `image` input support to OpenCode.
- Added debug tracing for hydrated model image capability and payload image-part preservation during request transformation.

### Changed

- Updated README with a dedicated vision/image-input troubleshooting section, payload examples, and self-test commands.
- Expanded `models.dev` family matching for routed model IDs like `codex/gpt-5.4` by checking slash-family aliases during enrichment.

### Fixed

- Fixed GPT-5/Codex-style routed models losing image capability during runtime hydration because seeded provider metadata was overriding fresher runtime capability data.
- Fixed OpenCode image prompts degrading into injected text errors instead of serializing `input_image` for supported OmniRoute Codex models.

### Verification

- Verified `omniroute/codex/gpt-5.4` remains hydrated with `attachment=true` and `input.image=true` across provider bootstrap and runtime refresh.
- Verified dropped/pasted images serialize as `input_image` and are successfully processed by OmniRoute-routed Codex models in local OpenCode testing.

## [1.2.3] - 2026-04-03

## [1.2.5] - 2026-04-04

### Changed

- Updated README fallback guidance to document MLX/Qwen routed models that may emit Chat Completions chunks on the Responses path.

### Fixed

- Fixed MLX/Qwen routed models such as `mlx/mlx-community/Qwen3.5-4B-MLX-8bit` being exposed to the Responses runtime even when OmniRoute streamed `chat.completion.chunk` payloads.

### Verification

- Verified `npm test` passes with regression coverage for MLX/Qwen Responses fallback behavior.

### Added

- Added per-model `apiMode` overrides through `modelMetadata` and seeded `provider.omniroute.models` entries.

### Changed

- Updated README with per-model `apiMode` override examples and guidance for mixed provider backends.

### Fixed

- Fixed mixed-backend OmniRoute setups where some routed models need `chat` runtime while others work with `responses`.
- Fixed Anthropic/Opus-style routed models failing under Responses streaming validation by allowing targeted per-model fallback/override behavior.

### Verification

- Verified `npm test` passes after per-model runtime override support.

## [1.2.2] - 2026-04-03

### Changed

- Switched final Responses API runtime integration to `@ai-sdk/openai` for better alignment with OpenCode custom-provider behavior.
- Updated reasoning variant generation so Responses mode keeps standard effort variants visible.
- Merged generated reasoning variants with explicit custom variants like `xhigh` instead of replacing them.
- Rewrote README to clearly document the OmniRoute-specific value of this standalone package versus a generic fork.

### Fixed

- Fixed Responses mode models only showing custom variants (for example `xhigh`) while dropping generated `low` / `medium` / `high` variants.
- Fixed Responses request normalization order so `reasoningEffort` is preserved as `reasoning.effort` in outgoing Responses payloads.

### Verification

- Verified responses-mode variant picker exposes merged reasoning variants in local OpenCode testing.
- Verified `npm test` passes after provider/runtime and variant-merging fixes.

## [1.2.1] - 2026-04-03

### Changed

- Switched `apiMode: 'responses'` runtime wiring from `@ai-sdk/openai-compatible` to `@ai-sdk/openai`.
- Updated responses-mode runtime wiring to keep using the OmniRoute base URL and let the OpenAI SDK target `/v1/responses` natively.
- Updated README configuration notes to document real runtime behavior for `responses` mode.

### Fixed

- Fixed `apiMode: 'responses'` having no practical effect because upstream OpenAI-compatible provider always targeted `/chat/completions`.
- Fixed OmniRoute responses compatibility by stripping unsupported token limit fields from `/responses` requests.

### Verification

- Verified local OpenCode config can load the plugin directly from the repository path for testing.
- Verified `npm test` passes after provider/runtime switching and request normalization changes.

## [1.0.3] - 2026-03-01

### Added

- Added dual provider API mode support (`chat` and `responses`) through `provider.omniroute.options.apiMode`.
- Added `OmniRouteApiMode` type and re-exported it for consumers.
- Added `OMNIROUTE_ENDPOINTS.RESPONSES` constant.
- Added `runtime` subpath export (`opencode-omniroute-auth/runtime`) for helper APIs and runtime constants.
- Added export validation script (`check:exports`) to enforce plugin-loader-safe root exports before publish.
- Added release planning and handover documentation (`docs/responses-api-evaluation-plan.md`, `docs/session-handover.md`).

### Changed

- Changed provider bootstrap logic to normalize and validate `apiMode` values, defaulting invalid values to `chat` with warnings.
- Changed package root runtime export shape to plugin-only exports (`default` + `OmniRouteAuthPlugin`) for OpenCode loader compatibility.
- Changed programmatic helper import path from package root to `opencode-omniroute-auth/runtime`.
- Updated README configuration and troubleshooting documentation to cover `apiMode`, npm plugin loading behavior, and runtime helper import path.
- Updated TypeScript build config to include `runtime.ts`.

### Fixed

- Fixed npm plugin loading failure outside the repository caused by non-function root exports being treated as plugin functions by OpenCode loader.

### Verification

- Verified `npm run prepublishOnly` passes (`clean`, `build`, and `check:exports`).
- Verified built root module exports only callable plugin functions.
- Verified runtime helpers/constants remain available through `opencode-omniroute-auth/runtime`.
- Verified packed local tarball (`1.0.3`) installs and exposes the expected export shape.

## [1.0.2] - 2026-03-01

### Added

- Added initial export-shape validation check before publishing.

### Changed

- Introduced default plugin export intended to improve compatibility with plugin loaders expecting default exports.
- Updated README troubleshooting notes for npm plugin loading.

### Notes

- This version improved compatibility but did not fully resolve OpenCode loader behavior when non-function runtime exports were present at package root.

## [1.0.1] - 2026-03-01

### Changed

- Version bump and package republish metadata update after initial release.

## [1.0.0] - 2026-03-01

### Added

- Initial OpenCode OmniRoute authentication plugin release.
- `/connect` authentication flow for storing and validating OmniRoute API keys.
- Dynamic model discovery from `/v1/models`.
- TTL-based model caching with fallback model behavior.
- Request interception for Authorization header injection and safe base URL handling.
- OpenAI-compatible provider wiring for OmniRoute usage in OpenCode.
