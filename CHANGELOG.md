# Changelog

All notable changes to this project are documented in this file.

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
