# Getting started

SpaceApp packages its application services and redistributable AI coding CLIs
in containers on Docker or rootless Podman. The host needs Node.js only for the
small `spaceapp` launcher, and enough resources for the stack. Docker remains the
default. If Docker is absent and Podman is installed, the launcher offers Podman
(or selects it with `--non-interactive`); otherwise it installs and starts Docker
when needed.

## Requirements

Minimum (the `small` profile):

- 4 CPU cores;
- 8 GB-class system RAM (the launcher requires at least 7 GiB reported by the
  operating system);
- 6.5 GiB free disk for a fresh installation;
- Node.js 20.11 or newer.

The `large` profile, which adds managed browser sessions, requires:

- 8 CPU cores;
- 15 GiB RAM;
- 11 GiB free disk.

## Linux

Install Node.js 20.11 or newer, then run as a normal non-root user:

```bash
npx --yes run-spaceapp@latest install
```

Linux runs the containers directly through the host Docker Engine; SpaceApp
does not create a second guest VM. The launcher runs as the current non-root
user so the installation remains in that user's config directory. If Docker is
selected but missing on Ubuntu, Debian, Fedora, RHEL, or CentOS, the launcher adds Docker's
official repository. On Arch-family systems, including CachyOS, it installs
the native `docker` and `docker-compose` packages through `pacman`. It then
starts the service. Before adding the current user to the `docker` group, it
explains that the group grants root-level privileges, adds the user
automatically, and continues in the same command.

## macOS

Install Node.js 20.11 or newer, then run in Terminal:

```bash
npx --yes run-spaceapp@latest install
```

If Docker is selected but missing, the launcher asks you to review and accept
Docker Desktop's terms, downloads the official architecture-specific DMG, verifies
its code signature, installs it, starts it, and waits until it is ready. Docker
Desktop uses its managed lightweight Linux environment. Apple Silicon uses the
native `linux/arm64` images and Intel Macs use `linux/amd64`.

## Rootless Podman (Linux and macOS)

Install [Podman](https://podman.io/docs/installation) **>=5.0** and **Docker
Compose v2 >=2.20.0**, with the `docker-compose` executable on `PATH`.
The launcher calls `podman compose` with Docker Compose v2 as its provider.
Python `podman-compose` and other major versions of Docker Compose are not
supported. The provider supports the stack's profiles, file-based secrets, health dependencies including
`required: false`, `init`, CPU/memory limits, shared socket volumes, `--wait`, and
`exec`/`run --user 10001:10001`. No Docker daemon is needed. See
[Podman's Compose provider configuration](https://docs.podman.io/en/latest/markdown/podman-compose.1.html).

On Linux, use your normal unprivileged account. Rootless Podman needs subordinate
UID/GID ranges, cgroup v2 and delegated CPU and memory controllers. Check the
current engine and the launcher diagnostics:

```bash
systemctl --user enable --now podman.socket
podman info
npx --yes run-spaceapp@latest install --engine podman --profile small
npx --yes run-spaceapp@latest doctor
```

If CPU/memory delegation is missing, an administrator must enable those
controllers for the systemd user service before installation. See the
[Podman rootless troubleshooting guide](https://github.com/containers/podman/blob/main/troubleshooting.md#26-running-containers-with-resource-limits-fails-with-a-permissions-error).
The launcher reports unavailable limits before starting the stack. It does not
install Podman or change the host's cgroup delegation, including with
`doctor --fix`.

On macOS, create and start a rootless Podman machine first. This example leaves
headroom above the `small` profile's minimum:

```bash
podman machine init --cpus 4 --memory 8192 --disk-size 30
podman machine start
npx --yes run-spaceapp@latest install --engine podman --profile small
```

Machine CPU, memory and free storage must meet the chosen profile, independently
of your Mac's capacity. The launcher checks them and gives resizing guidance.
For QEMU machines, stop the machine, resize, then start it again; for example:

```bash
podman machine stop <name>
podman machine set --cpus 8 --memory 16384 --disk-size 40 <name>
podman machine start <name>
```

Disk size can only grow. Other machine providers may require recreation instead
of resizing: back up existing data before doing that. Consult
[`podman machine set`](https://docs.podman.io/en/latest/markdown/podman-machine-set.1.html)
for provider-specific restrictions.

Engine selection is stored as `engine` in the installation's `config.json`.
Every subsequent command, including backups, updates and uninstall, uses that
engine. Scripted installation also accepts `--answers answers.json` with
`{"confirm":true,"engine":"podman","open":false}`. An explicit
`--engine docker` keeps the Docker path.
Old installations with no engine field still use Docker. The launcher refuses
engine changes on an existing installation because the engines cannot see each
other's volumes; no in-place engine migration is supported. Podman supports only
`--access isolated`; `--access host-root` is refused. Podman on Windows/WSL is
outside the supported scope.

## Windows 11 — Command Prompt

Enable hardware virtualization and install Node.js 20.11 or newer. Open
**Command Prompt**, or select the **Command Prompt** profile in Windows
Terminal, and run:

```bat
npx --yes run-spaceapp@latest install
```

Do not run the universal command from a PowerShell profile whose execution
policy is `Restricted`: Windows can block npm's `npx.ps1` before SpaceApp gets
a chance to run. Command Prompt invokes npm's `npx.cmd` shim with the same
universal command and needs no execution-policy change.

If Docker is missing, the launcher asks you to review and accept Docker
Desktop's terms, requests a Windows UAC approval when WSL2 or the package
installation requires it, and prefers the official Docker Desktop package
through Windows Package Manager. Windows Package Manager verifies the
installer against its hash-pinned `Docker.DockerDesktop` manifest. If Windows
Package Manager is unavailable or fails, the launcher downloads Docker Desktop
from Docker's official distribution service and verifies its Authenticode
signature before running it. The launcher then starts Docker Desktop and waits
until it is ready. On the first launch, Docker Desktop may show a
**Welcome to Docker** screen before starting the Engine. Select **Skip** in the
top-right (or sign in), accept any remaining Docker prompt, and leave the
terminal open. SpaceApp waits for up to ten minutes and continues automatically
when Docker becomes ready. Windows may request a UAC approval or one restart.
When WSL2 needs the restart, SpaceApp registers a one-time resume and asks
before scheduling it. Save your work, approve the restart, and sign back in;
the installer resumes automatically in Command Prompt without entering the
command again. SpaceApp reuses Docker Desktop's WSL2 Linux environment and does
not install a second full virtual machine.

## Installation profiles

The universal install command defaults to `--profile auto`:

| Profile | Services | CPU | Usable RAM | Fresh free disk |
| --- | --- | --- | --- | --- |
| `small` | core, OpenCode, PostgreSQL | 4 | 7 GiB | 6.5 GiB |
| `medium` | small + Temporal/background integration workers | 4 | 11 GiB | 8 GiB |
| `large` | medium + managed Chromium, larger resource limits | 8 | 15 GiB | 11 GiB |

Auto chooses the largest profile that fits all three resources, then checks
the engine's allocation. Existing installations preserve their profile during an
upgrade. `light` and `standard` keep compatibility settings for older installs.
Additional providers and companions install only when requested.

```bash
npx --yes run-spaceapp@latest install --profile small
npx --yes run-spaceapp@latest install --profile medium
npx --yes run-spaceapp@latest install --profile large
```

Small limits core and CLI to 2 GiB each and PostgreSQL to 768 MiB. Medium adds
background workflow/integration workers; large adds managed browser automation.
Small disables those background services, including automatic Telegram delivery
and streaming bot workers. Room/pane budgets and UI behavior are unchanged.
Limits are upper bounds, not memory reserved at startup.

## Linux host access

Installation profiles do not control filesystem permissions. Every profile
uses isolated access by default, where only registered workspaces are mounted.

Host-root access is meant for a disposable, trusted single-owner Linux
machine:

```bash
npx --yes run-spaceapp@latest install --access host-root
```

That mode remains one Docker-based SpaceApp build across Linux distributions.
It mounts the host `/` at `/host`, read-only in the core service and read/write
in the CLI service. The CLI service runs its sessions as container root only
in this mode. On a normal rootful Docker Engine, this is equivalent to
host-root file access: an agent can read credentials, change boot or package
files, or destroy the operating system.

The mode does not mount the Docker socket and does not enable `privileged`,
host PID, host network, host IPC, or host device access. Those omissions reduce
the attack surface but do not make a writable host root safe from a malicious
or mistaken CLI command.

Omitting `--access` preserves the current mode. New and migrated installations
default to `isolated`. To remove the host root mount while preserving SpaceApp
data, credentials, workspaces, secrets, and persistent volumes, run:

```bash
npx --yes run-spaceapp@latest install --access isolated
```

Host-root is supported only on Linux with Docker; the launcher refuses it
with Podman and on macOS and Windows.

The `npx` command is the universal one-command installer. To retain a global
launcher for later operations, optionally run `npm install -g run-spaceapp`;
this is not required for the first install.

## Disk usage

Fresh installations use profile-specific free-space checks (6.5/8/11 GiB).
The installer does not preallocate this space.
Upgrades require only missing image layers, a database checkpoint and 0.5 GiB
headroom. Target images already cached need no extra image space. Registry layer
metadata excludes shared layers when available; offline/unknown metadata uses a
conservative estimate. The launcher checks space again after pull and before
cutover. Existing workspaces and volumes are retained in place, never duplicated
or deleted for space. The engine's separate disk capacity is checked when measurable;
an unavailable measurement is reported. Data size and optional companions can
increase the requirement.

On Windows and macOS, the number shown as Docker Desktop's disk limit is a
maximum, not an immediate allocation: the managed sparse virtual disk grows as
data is written. Removing images or volumes releases space inside Docker, but
the host-side sparse file may require Docker Desktop's reclaim/compact action
before its visible file size shrinks.

## What the command does

The universal install command performs
`initialize → prerequisites → doctor → pull → up → readiness → setup status → open`. It creates
non-secret configuration, fresh database/session secrets, and a one-time setup
token; installs Docker from official sources when required; checks CPU, RAM,
free disk, the selected engine CLI, Compose, and engine readiness; downloads the selected
images; starts the services; waits up to ten minutes for `/readyz`; verifies
first-owner status; and opens `http://127.0.0.1:4911`.

The command is idempotent. Running it again preserves the installation's
long-lived secrets, data, and provider state. While the owner remains
unclaimed, each successful install replaces only the setup token with a fresh
15-minute value after the database accepts it, then prints that value at the
end. Use `--no-open` on headless machines.

The default installation roots are:

| Platform | Default path |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/spaceapp` or `$HOME/.config/spaceapp` |
| macOS | `$HOME/Library/Application Support/SpaceApp` |
| Windows | `%APPDATA%\SpaceApp` |

To isolate an installation or clean-room test, set `SPACEAPP_HOME` to an
absolute path before every launcher command.

## Register a workspace

SpaceApp mounts no host project by default. Register only directories the CLI
tools are allowed to read or modify:

```bash
# Linux
npx --yes run-spaceapp@latest workspace add /home/alice/code/example

# macOS
npx --yes run-spaceapp@latest workspace add /Users/alice/code/example

# Windows PowerShell
npx --yes run-spaceapp@latest workspace add "C:\Users\Alice\code\example"
```

Use `--read-only` when the tools should not modify the directory:

```bash
npx --yes run-spaceapp@latest workspace add /absolute/path/to/reference --read-only
npx --yes run-spaceapp@latest workspace list
npx --yes run-spaceapp@latest workspace remove /absolute/path/to/reference
```

Adding a workspace grants the application CLIs access to that host directory.
Repository files are untrusted input, so review the project and its agent
instructions before allowing tools to operate on it.

`workspace add` and `workspace remove` apply the change to the running
services. Run `npx --yes run-spaceapp@latest up` only if the command says the
services could not pick it up.

On Linux with Docker, the CLIs run as uid 10001, and a mounted folder keeps its
host owner. When they cannot write to it, `workspace add` prints the command that
gives them access without changing the owner (install the `acl` package if
`setfacl` is missing):

```bash
sudo setfacl -R -m u:10001:rwX -m u:$(id -u):rwX -m d:u:10001:rwX -m d:u:$(id -u):rwX /home/alice/code/example
```

With rootless Podman, workspace services use `keep-id` to map your host UID/GID
to container UID/GID 10001. Files created in a writable workspace are owned by
your user on the host; the launcher does not recursively change ownership. Use
directories you own and already have permission to access. Read-only workspaces
remain read-only.

On SELinux hosts, Podman workspace mounts include `:z` to label the directory for
sharing between core and CLI. Private `:Z` labeling is unsuitable because both
services use the same directory. SELinux relabeling applies even to read-only
mounts; register project directories, not system directories or your entire home.

## First browser setup

The install command starts the stack and opens the first-run page. If the
browser was closed or `--no-open` was used, run
`npx --yes run-spaceapp@latest open`. The application binds to
`http://127.0.0.1:4911` by default.

On the first page:

1. copy the one-time setup token printed at the end of the install command and
   paste it into the field with the same name;
2. create the owner email and a password of at least 12 characters;
3. sign in as that owner;
4. connect one CLI provider at a time, **starting with OpenCode** — its
   starter model is the free Big Pickle (`opencode/big-pickle`). On first
   launch SpaceApp checks it with a real tool call and falls back to another
   free model if it fails (see [CLI providers](cli-providers.md)), so no paid
   account or API key is required to get a working agent;
5. create a test room and verify the selected workspace;
6. run `npx --yes run-spaceapp@latest backup` before the first update.

There is no default owner password or production development-login fallback.
The setup claim is single-use.

If the 15-minute token expires before the first owner is claimed, rotate it
locally and use the newly printed value:

```bash
npx --yes run-spaceapp@latest owner rotate-setup-token
```

Rotation is refused after an owner exists.

## Connect providers

Open the CLI provider setup inside SpaceApp and use the provider's official
OAuth, device-code, or login flow. **Connect OpenCode first**: the bundled
OpenCode runtime starts on the free Big Pickle model, or on another free model
that passes the first-launch check, which gives a working agent without a paid
plan or API key. Then continue with the other providers as needed. For
providers that support direct API keys, the launcher also accepts a value from
masked standard input:

```bash
npx --yes run-spaceapp@latest credentials list
npx --yes run-spaceapp@latest provider install claude
npx --yes run-spaceapp@latest credentials set claude
npx --yes run-spaceapp@latest credentials set gemini
```

`credentials set claude` and `credentials set codex` store an Anthropic and an
OpenAI API key; OpenCode uses the same two keys for its Anthropic and OpenAI
models (choose them with `/models`). `credentials set opencode` takes an
OpenCode Zen key only.

Credentials are never accepted as command-line arguments. See
[CLI providers](cli-providers.md) for bundled versus owner-installed versions,
authentication methods, storage boundaries, and the experimental DeepSeek
warning.

## Verify the installation

```bash
npx --yes run-spaceapp@latest doctor
npx --yes run-spaceapp@latest status
npx --yes run-spaceapp@latest logs
```

`doctor` checks Node.js, the selected engine CLI, Compose, engine readiness,
CPU, memory and free disk. It reports engine/version, rootless or rootful mode,
cgroup version and whether CPU/memory limits are delegated. For Podman, missing
limit delegation is a prerequisite failure with setup guidance. `support-bundle`
includes the same engine facts without credentials. Diagnostics distinguish a
missing CLI or Compose provider from a stopped or inaccessible engine.
The `small` profile should show core, CLI, and PostgreSQL running; `medium`
adds Temporal, and `large` also adds the browser service. If startup is still
in progress, wait for the health checks and inspect bounded logs.

## Source-checkout test path

A clean-room operator can also build the three images from a verified source
commit with the exact tag expected by the launcher. Replace `<version>` with
`spaceappRuntimeVersion` from `packages/run-spaceapp/package.json`:

```bash
npm ci
docker build --target core --tag ghcr.io/oll4com/spaceapp-core:<version> .
docker build --target browser --tag ghcr.io/oll4com/spaceapp-browser:<version> .
docker build --target cli --tag ghcr.io/oll4com/spaceapp-cli:<version> .
npm install -g ./packages/run-spaceapp
```

Then set a new `SPACEAPP_HOME` and follow `init → doctor → workspace add → up
→ open` so the launcher uses the already-built local tags without a registry
pull. This proves a source build; it does **not** prove the public npm tarball
or GHCR manifests. Follow [Clean-room testing](clean-room-testing.md) for the
complete acceptance checklist.
