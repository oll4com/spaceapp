---
name: space-anthropic-skills
description: Anthropic's skill-creator and mcp-builder skills. Use when the user wants to create, edit, evaluate or benchmark a skill, or tune a skill's description so it triggers reliably; or when building or reviewing an MCP server (tool design, schemas, pagination, errors, evaluations) in TypeScript or Python.
metadata:
  category: WORKFLOW
---

# Anthropic Skills

Two skills from [anthropics/skills](https://github.com/anthropics/skills). Read the one the task needs and follow it.

| Skill | Use when | Read |
| --- | --- | --- |
| `skill-creator` | Creating or improving a skill, running evals and benchmarks for it, or optimizing its description. | [skill-creator/SKILL.md](skill-creator/SKILL.md) |
| `mcp-builder` | Building or reviewing an MCP server and its tools. | [mcp-builder/SKILL.md](mcp-builder/SKILL.md) |

Both skills end with an "In Space" section. Repository and operator instructions (`AGENTS.md`) take precedence. Superpowers' `writing-skills` covers writing a skill test-first; `skill-creator` adds the evaluation, benchmark and description-tuning loop.

Source and licenses: [UPSTREAM.md](UPSTREAM.md).
