---
name: space-wshobson-skills
description: Seventeen specialist skills from wshobson/agents for TypeScript/JavaScript (advanced types, modern patterns, Node.js backends, Jest/Vitest testing), security (STRIDE threat modeling, attack trees, security requirements, threat-to-control mapping, SAST setup with Semgrep/SonarQube/CodeQL), incidents (runbooks, on-call handoffs, blameless postmortems, network connectivity triage) and observability (Prometheus, Grafana dashboards, distributed tracing, SLIs/SLOs and error budgets). Use when a task needs one of these specialties.
metadata:
  category: WORKFLOW
---

# wshobson Skills

Skills from four plugins of [wshobson/agents](https://github.com/wshobson/agents). Read only the skill the task needs, then its `references/` file when the skill points to it.

| Plugin | Skill | Use when |
| --- | --- | --- |
| javascript-typescript | [typescript-advanced-types](typescript-advanced-types/SKILL.md) | Generics, conditional, mapped and template-literal types, utility types |
| | [modern-javascript-patterns](modern-javascript-patterns/SKILL.md) | ES6+ features, async patterns, modules, functional patterns |
| | [nodejs-backend-patterns](nodejs-backend-patterns/SKILL.md) | Node.js services: middleware, errors, auth, database access, API design |
| | [javascript-testing-patterns](javascript-testing-patterns/SKILL.md) | Unit, integration and end-to-end tests with Jest, Vitest and Testing Library |
| security-scanning | [stride-analysis-patterns](stride-analysis-patterns/SKILL.md) | STRIDE threat modeling of a system or feature |
| | [attack-tree-construction](attack-tree-construction/SKILL.md) | Mapping attack paths and defense gaps |
| | [security-requirement-extraction](security-requirement-extraction/SKILL.md) | Turning threats into concrete security requirements and test cases |
| | [threat-mitigation-mapping](threat-mitigation-mapping/SKILL.md) | Mapping threats to controls and prioritizing remediation |
| | [sast-configuration](sast-configuration/SKILL.md) | Choosing and configuring static analysis (Semgrep, SonarQube, CodeQL) and custom rules |
| incident-response | [incident-runbook-templates](incident-runbook-templates/SKILL.md) | Writing an outage runbook with steps, escalation and recovery |
| | [on-call-handoff-patterns](on-call-handoff-patterns/SKILL.md) | Handing an ongoing incident or shift to someone else |
| | [postmortem-writing](postmortem-writing/SKILL.md) | Blameless postmortem with timeline, root cause and action items |
| | [connectivity-triage](connectivity-triage/SKILL.md) | DNS, LAN, upstream-path or remote-service connectivity faults, API/MCP timeouts |
| observability-monitoring | [prometheus-configuration](prometheus-configuration/SKILL.md) | Prometheus scrape config, recording and alert rules |
| | [grafana-dashboards](grafana-dashboards/SKILL.md) | Grafana dashboards for system and application metrics |
| | [distributed-tracing](distributed-tracing/SKILL.md) | Tracing requests across services with Jaeger or Tempo |
| | [slo-implementation](slo-implementation/SKILL.md) | SLIs, SLOs, error budgets and burn-rate alerts |

## In Space

Repository and operator instructions (`AGENTS.md`) take precedence over these skills.

- **Stack.** The Space repository uses TypeScript ESM on Node, Fastify, PostgreSQL, Temporal, zod 4 and Vitest. Follow its existing patterns and tests over the generic Express, Mongoose or Jest examples. Use the `context7` backend for current library documentation.
- **Incidents on Space itself.** Start with `space_status` and `space_logs` (see `space-control-mcp`), and `space-app-diagnostics` for `APP_DEBUG`. Do not restart services, the pane host or the browser host yourself, and do not stop other sessions' processes: service actions go through the existing gates and the operator. Fixes ship only through the merge queue.
- **connectivity-triage** was written for macOS (`scutil`). On the Linux Space host use the equivalents (`resolvectl`, `ip route`, `dig`, `curl`) and stay non-destructive.
- **Security scanning.** Run scanners locally and report findings by file and line; never print secrets you find. Ask the operator before installing scanners, starting containers (SonarQube) or setting up CodeQL on the shared host, and never send code to a hosted scanner or use a scanner token without consent. The `scripts/run-sast.sh` mentioned in `sast-configuration` is not part of the upstream skill.
- **Observability.** Check what the project actually runs before adding Prometheus, Grafana or tracing configuration. Space's own health comes from `/readyz`, `space_status` and its diagnostics.
- Runbooks, postmortems, threat models and reports go to `/var/lib/spaceapp-user/agent-workspace/reports/YYYYMMDD-HHMM-<topic>/` unless the user wants them in a repository. Publish to Agent Files only when the user explicitly asks for a file.
- Only the skills are installed: the plugins' agents and commands are not.

Source and license: [UPSTREAM.md](UPSTREAM.md).
