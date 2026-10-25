<!-- Modified by SpaceApp (2026-10-12) from garrytan/gstack@e23f7b8: ship-owned documentation mode removed; Space docs added to discovery. -->
# Documentation scope and discovery

## Discovery

Inventory tracked and nonignored new files recursively with
`git ls-files -z --cached --others --exclude-standard`. Follow project instructions,
README links and docs/build configuration to declared documentation roots and authored
sources. Include relevant `.md`, `.mdx`, `.rst`, `.adoc`, `.txt` and `.tmpl` files;
role, not extension alone, determines relevance. Exclude `.git`, dependencies
(`node_modules`, vendor, virtualenvs), `.context`, caches, build artifacts
and generated output from edits. Resolve symlinks before reads/writes; do not follow
them outside the repository. Edit generated docs' authored sources. Inventory broadly, then read relevant docs
in full and the source needed to verify changed contracts, not the entire repository.

In the Space repository, always include `docs/SPACEAPP_CAPABILITIES_SPEC.md`
(symlinked as `SPACEAPP_CAPABILITIES.md`) and `AGENTS.md`.
