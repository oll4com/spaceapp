## SpaceApp 1.1.0

### Highlights & Changes
- **Companion Skills & AI Superpowers**: Integrated the new companion skills ecosystem (Superpowers, UI-UX Pro Max, Taste Skill, No AI Slop).
- **Plugins & MCP Enhancements**:
  - Redesigned Plugins & MCP UI with high-contrast status badges (preview, connect, connected, disconnect).
  - Comprehensive tool summaries, GitHub repository links, and live version tracking for installed MCP plugins.
  - One-click "Upgrade All" capability for outdated MCP plugins.
- **Security & Stability**:
  - AST-enforced route rate limits for sensitive configuration endpoints (`/api/configuration/inspect` and `/import`).
  - Strict immutable multi-arch candidate verification with verified SBOM and provenance v1 attestations.
  - Clean high/critical vulnerability scanning across all containers.

### Installation & Update Commands
- **Fresh installation**:
  ```bash
  npx --yes run-spaceapp@latest install
  ```
- **Update existing installation**:
  ```bash
  npx --yes run-spaceapp@latest update
  ```

### Release Verification & Artifacts
- **Workflow Run**: [GitHub Actions Run #37003368945](https://github.com/oll4com/spaceapp/actions/runs/37003368945)
- **Container Images (GHCR)**:
  - `ghcr.io/oll4com/spaceapp-core:1.1.0` (`linux/amd64`, `linux/arm64`)
  - `ghcr.io/oll4com/spaceapp-cli:1.1.0` (`linux/amd64`, `linux/arm64`)
  - `ghcr.io/oll4com/spaceapp-browser:1.1.0` (`linux/amd64`, `linux/arm64`)
- **npm Registry**:
  - Package: [`run-spaceapp@1.1.0`](https://www.npmjs.com/package/run-spaceapp)
  - Tags: `latest: 1.1.0`, `next: 1.1.0`
