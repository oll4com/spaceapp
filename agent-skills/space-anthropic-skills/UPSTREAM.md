# Upstream

- Repository: https://github.com/anthropics/skills
- Commit: `dbd4588f9e1033efb41dad4bef2f7947c8993d44`
- License: Apache License 2.0 for both skills; the full text is in each skill's `LICENSE.txt`.

## Files

- `skills/skill-creator/`: `SKILL.md`, `LICENSE.txt`, `agents/{grader,comparator,analyzer}.md`, `references/schemas.md`, `eval-viewer/{generate_review.py,viewer.html}`, `assets/eval_review.html`, `scripts/{__init__,utils,quick_validate,aggregate_benchmark,generate_report,run_eval,run_loop,improve_description}.py`
- `skills/mcp-builder/`: `SKILL.md`, `LICENSE.txt`, `reference/{mcp_best_practices,node_mcp_server,python_mcp_server,evaluation}.md`

Not copied: `skill-creator/scripts/package_skill.py` (Space does not package `.skill` files) and `mcp-builder/scripts/` (the evaluation runner needs an Anthropic API key and packages that Space does not install).

## Modified files (Apache-2.0 §4(b))

Each modified file carries a notice at the top.

- `skill-creator/SKILL.md`: workspace location under the reports root, static viewer only, eval-set review in the conversation, description-loop paths and worker count, final step, and the Claude.ai, Cowork and packaging sections replaced by "In Space".
- `skill-creator/eval-viewer/generate_review.py`: server mode no longer sends SIGTERM to whatever process holds its port; it falls back to a free port.
- `mcp-builder/SKILL.md`: pinned Inspector version, a note that the evaluation runner is not installed, and an "In Space" section.
- `mcp-builder/reference/evaluation.md`: the retired default model (Claude 3.7 Sonnet) is replaced by `claude-sonnet-5-5`.

Everything else is unchanged.

## Not vendored

The `docx`, `pdf`, `pptx` and `xlsx` skills are proprietary (source-available only under an agreement with Anthropic) and may not be copied, modified or redistributed. `doc-coauthoring` has no license.
