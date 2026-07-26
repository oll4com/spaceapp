# CLI providers and credentials

The public CLI image bundles pinned executables whose reviewed licenses permit
redistribution. SpaceApp does not bundle provider accounts, API keys, OAuth
grants, subscriptions, or usage credits.

## Bundled inventory

| Runtime | Package and pinned version | Normal owner setup |
| --- | --- | --- |
| Codex CLI | `@openai/codex@0.145.0` | official device-code login or API key |
| Gemini CLI | `@google/gemini-cli@0.52.0` | official Google OAuth or API key |
| OpenCode | `opencode-ai@1.18.4` | `opencode auth login` provider flow |
| Qwen Code | `@qwen-code/qwen-code@0.20.1` | official `/auth` provider menu or API key |
| Kimi Code | `@moonshot-ai/kimi-code@0.29.0` | official Kimi OAuth login |
| Grok Build | `@xai-official/grok@0.2.111` | official xAI device-code login |
| DeepSeek CLI | `run-deepseek-cli@0.1.1` | masked DeepSeek API key setup |

## Owner-installed Claude Code

Claude Code is not included in published SpaceApp images because the reviewed
package does not provide an open-source redistribution license. An owner can
install the reviewed version into the current installation's private provider
volume:

```bash
npx --yes run-spaceapp@latest provider install claude
```

That command downloads `@anthropic-ai/claude-code@2.1.206` directly from npm
as an owner-initiated action. Use remains subject to Anthropic's current terms.

DeepSeek support is **community/experimental**. `run-deepseek-cli` is not an
official DeepSeek CLI, and the current adapter uses its fixed
`deepseek-v4-flash` text-chat path. Evaluate its package, behavior, license,
and suitability before enabling it.

Provider names and trademarks belong to their respective owners. Each CLI and
upstream service remains governed by its own license, terms, privacy policy,
regional availability, and billing.

## Preferred setup flow

1. Start SpaceApp and sign in as the owner.
2. Select one CLI runtime that reports `LOGIN_REQUIRED` or `SETUP_REQUIRED`.
3. Open its protected login/setup terminal.
4. Complete the provider's official flow. Never paste a credential into room
   chat, an issue, a prompt, or a workspace file.
5. Confirm the runtime reports ready before connecting another provider.

The public wrappers isolate each runtime under:

```text
/var/lib/spaceapp-cli/providers/<provider>
```

The CLI container uses an isolated `HOME`, temporary directory, and provider
configuration root for every runtime. Provider credentials are not copied from
the developer or host user.

## Masked API-key input

For supported direct-key flows:

```bash
npx --yes run-spaceapp@latest credentials list
npx --yes run-spaceapp@latest credentials set <provider>
```

The value is read from masked standard input, not from a command argument. It
is written with restrictive permissions below the installation's
`secrets/providers` directory. A fixed Compose command recreates only the CLI
service, copies the current allowlisted files into its protected provider
volume, and removes stale copies. The application core never mounts the raw
provider-key directory.

Remove an imported key with:

```bash
npx --yes run-spaceapp@latest credentials remove <provider>
```

Removing an imported key does not revoke it at the provider. Revoke or rotate
the key in the provider account when compromise is possible. Setting or
removing a key recreates the CLI service, so finish or stop active CLI sessions
first.

## OAuth and device state

OAuth, device-code, and official CLI login state is stored in the
`spaceapp-cli-state` Docker volume. The application core does not mount that
volume or the host provider-key directory; runtime operations cross the
protected CLI-host socket instead.

Portable backups created with `npx --yes run-spaceapp@latest backup`
intentionally exclude:

- imported provider API-key files;
- the `spaceapp-cli-state` provider volume;
- host workspace contents.

After moving an installation to another host, reconnect each provider and
re-register the host workspaces. This prevents a portable application backup
from silently becoming a credential bundle.

## Updates

Bundled provider versions change only through a reviewed SpaceApp CLI-image
release. Claude Code remains outside the distributed image; rerun
`npx --yes run-spaceapp@latest provider install claude` only when deliberately
installing the reviewed owner-managed version. Update SpaceApp images through
`npx --yes run-spaceapp@latest install`, then verify provider readiness again.
