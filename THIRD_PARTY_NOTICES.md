# Third-party notices

SpaceApp application source and the run-spaceapp launcher are MIT (from 1.1.7; earlier releases keep their license).
The CLI image includes OpenCode and installs other independent packages on demand
that retain their own licenses and terms. This inventory records the metadata
reviewed for the pinned SpaceApp 0.1.0 build; it is not legal advice and does not
grant rights beyond the upstream terms.

## Third-party code in SpaceApp

Parts of SpaceApp's own source are taken or ported from other projects. They keep their licence and notices; the full
texts are in `THIRD_PARTY_LICENSES/` in the repository and in every SpaceApp image (`/app/THIRD_PARTY_LICENSES`).

| Work | Licence | Used by | Text |
| --- | --- | --- | --- |
| Google Material Symbols | Apache-2.0 | `packages/icons` (Material Rounded icon pack) | `THIRD_PARTY_LICENSES/google-material-symbols.txt` |
| Headroom 0.37.0 | Apache-2.0 | `packages/gateway` context compression (TypeScript ports) | `THIRD_PARTY_LICENSES/headroom.txt` |
| unidiff-rs 0.4.1 | MIT | `packages/gateway` diff compressor (reduced TypeScript port) | `THIRD_PARTY_LICENSES/unidiff-rs.txt` |
| tree-sitter grammars (eight) | MIT | `packages/gateway/grammars/*.wasm` | `THIRD_PARTY_LICENSES/tree-sitter-grammars.txt` |
| codex-lb | MIT | `packages/gateway` (TypeScript ports) | `THIRD_PARTY_LICENSES/codex-lb.txt` |
| caveman 3.2.0 | Apache-2.0 | `packages/gateway` output policy CONCISE | `THIRD_PARTY_LICENSES/caveman.txt` |
| ponytail 5.2.0 | MIT | `packages/gateway` output policy LEAN | `THIRD_PARTY_LICENSES/ponytail.txt` |

## CLI packages

| CLI package | Version | Published license/terms | Source or terms | Release status |
| --- | --- | --- | --- | --- |
| `@openai/codex@0.145.0` | 0.145.0 | Apache-2.0 | [openai/codex](https://github.com/openai/codex) | reviewed |
| Claude Code (`@anthropic-ai/claude-code@2.1.301`) | 2.1.301 | “All rights reserved”; Anthropic Commercial Terms and legal agreements | [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | owner-installed only; not redistributed |
| `@google/gemini-cli@0.52.0` | 0.52.0 | Apache-2.0 | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | reviewed |
| `@opencode/cli@2.0.32` | 2.0.32 | MIT in npm metadata | [npm package](https://www.npmjs.com/package/@opencode/cli) | reviewed |
| `@qwen-code/qwen-code@0.20.1` | 0.20.1 | Apache-2.0 in the package `LICENSE` | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | reviewed |
| `@moonshot-ai/kimi-code@0.29.0` | 0.29.0 | MIT | [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) | reviewed |
| `@xai-official/grok@0.2.111` | 0.2.111 | Apache-2.0 in npm metadata | [npm package](https://www.npmjs.com/package/@xai-official/grok) | reviewed |
| `run-deepseek-cli@0.1.1` | 0.1.1 | MIT | [holasoymalva/deepseek-cli](https://github.com/holasoymalva/deepseek-cli) | reviewed with experimental warning |
| `autohand-cli@0.9.3` | 0.9.3 | Apache-2.0 | [autohand.ai/cli](https://autohand.ai/cli/) | reviewed |
| `@github/copilot@1.0.78` | 1.0.78 | GitHub Copilot CLI License (redistribution within a larger application permitted under conditions) | [github/copilot-cli](https://github.com/github/copilot-cli) | reviewed |
| `@anysphere/agent-cli-runtime` (Cursor CLI 2026.07.23-e383d2b, `agent-cli-package.tar.gz`) | 2026.07.23-e383d2b | No license declared; proprietary Cursor terms | [downloads.cursor.com](https://downloads.cursor.com) | reviewed; proprietary |

DeepSeek support is community/experimental. `run-deepseek-cli` is not an official DeepSeek CLI and must not be described as one.

Cursor CLI (`@anysphere/agent-cli-runtime`) declares no open-source license and
is distributed under Cursor's proprietary terms; its use of the bundled `node`
runtime and third-party node modules (for example `better-sqlite3`, `piscina`,
`bindings`) is subject to their respective licenses.

`@github/copilot` is distributed under the GitHub Copilot CLI License, which
permits redistribution only in unmodified form as part of an application or
service that provides material functionality beyond the software itself,
including a copy of that license. SpaceApp satisfies these conditions by
bundling the package in the CLI image only, and must not republish it as a
standalone product.

## Claude Code owner-installed boundary

The reviewed package does not provide an open-source redistribution license.
Claude Code is therefore not included in published SpaceApp images. An owner
may invoke the explicit `spaceapp provider install claude` command, which runs
an owner-initiated npm installation into that installation's private provider
volume and remains subject to Anthropic's terms.

Maintainers must not add Claude Code back to a distributed image without
written or counsel-reviewed confirmation that the planned redistribution is
permitted. Public npm availability alone is not redistribution permission.

## Bundled tree-sitter grammars

The core image ships `packages/gateway/grammars/*.wasm`, which the Space Gateway
compression worker loads for code-aware compression. Each file is the unmodified
WebAssembly build from its npm package (byte-identical, checked by SHA-256 when the
public tree is exported). The tree-sitter runtime (`web-tree-sitter@0.25.10`, MIT,
Copyright (c) 2018-2024 Max Brunsfeld) is an ordinary npm dependency.

| File | npm package | Source | License and copyright |
| --- | --- | --- | --- |
| `tree-sitter-c.wasm` | `tree-sitter-c@0.24.1` | [tree-sitter/tree-sitter-c](https://github.com/tree-sitter/tree-sitter-c) | MIT, Copyright (c) 2014 Max Brunsfeld |
| `tree-sitter-cpp.wasm` | `tree-sitter-cpp@0.23.4` | [tree-sitter/tree-sitter-cpp](https://github.com/tree-sitter/tree-sitter-cpp) | MIT, Copyright (c) 2014 Max Brunsfeld |
| `tree-sitter-go.wasm` | `tree-sitter-go@0.25.0` | [tree-sitter/tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go) | MIT, Copyright (c) 2014 Max Brunsfeld |
| `tree-sitter-java.wasm` | `tree-sitter-java@0.23.5` | [tree-sitter/tree-sitter-java](https://github.com/tree-sitter/tree-sitter-java) | MIT, Copyright (c) 2017 Ayman Nadeem |
| `tree-sitter-javascript.wasm` | `tree-sitter-javascript@0.25.0` | [tree-sitter/tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript) | MIT, Copyright (c) 2014 Max Brunsfeld |
| `tree-sitter-python.wasm` | `tree-sitter-python@0.25.0` | [tree-sitter/tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) | MIT, Copyright (c) 2016 Max Brunsfeld |
| `tree-sitter-rust.wasm` | `tree-sitter-rust@0.24.0` | [tree-sitter/tree-sitter-rust](https://github.com/tree-sitter/tree-sitter-rust) | MIT, Copyright (c) 2017 Maxim Sokolov |
| `tree-sitter-typescript.wasm` | `tree-sitter-typescript@0.23.2` | [tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | MIT, Copyright (c) 2017 Max Brunsfeld |

Each package is distributed under the MIT License. It permits use, copying,
modification, merging, publishing, distribution, sublicensing and sale, provided the
copyright notice above and the permission notice are included in all copies or
substantial portions; the software is provided "as is", without warranty of any
kind. The full MIT License text is in each package.
