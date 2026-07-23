# Third-party CLI notices

SpaceApp source is Apache-2.0, but the CLI image installs independent packages
that retain their own licenses and terms. This inventory records the metadata
reviewed for the pinned SpaceApp 0.1.0 build; it is not legal advice and does not
grant rights beyond the upstream terms.

| CLI package | Version | Published license/terms | Source or terms | Release status |
| --- | --- | --- | --- | --- |
| `@openai/codex@0.145.0` | 0.145.0 | Apache-2.0 | [openai/codex](https://github.com/openai/codex) | reviewed |
| Claude Code (`@anthropic-ai/claude-code@2.1.206`) | 2.1.206 | “All rights reserved”; Anthropic Commercial Terms and legal agreements | [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | owner-installed only; not redistributed |
| `@google/gemini-cli@0.52.0` | 0.52.0 | Apache-2.0 | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | reviewed |
| `opencode-ai@1.18.4` | 1.18.4 | MIT in npm metadata | [npm package](https://www.npmjs.com/package/opencode-ai) | reviewed |
| `@qwen-code/qwen-code@0.20.1` | 0.20.1 | Apache-2.0 in the package `LICENSE` | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | reviewed |
| `@moonshot-ai/kimi-code@0.29.0` | 0.29.0 | MIT | [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) | reviewed |
| `@xai-official/grok@0.2.111` | 0.2.111 | Apache-2.0 in npm metadata | [npm package](https://www.npmjs.com/package/@xai-official/grok) | reviewed |
| `run-deepseek-cli@0.1.1` | 0.1.1 | MIT | [holasoymalva/deepseek-cli](https://github.com/holasoymalva/deepseek-cli) | reviewed with experimental warning |

DeepSeek support is community/experimental. `run-deepseek-cli` is not an official DeepSeek CLI and must not be described as one.

## Claude Code owner-installed boundary

The reviewed package does not provide an open-source redistribution license.
Claude Code is therefore not included in published SpaceApp images. An owner
may invoke the explicit `spaceapp provider install claude` command, which runs
an owner-initiated npm installation into that installation's private provider
volume and remains subject to Anthropic's terms.

Maintainers must not add Claude Code back to a distributed image without
written or counsel-reviewed confirmation that the planned redistribution is
permitted. Public npm availability alone is not redistribution permission.
