#!/bin/sh
# Remove native prebuilds for platforms the image never runs on. Each runtime
# target installs only its dependency closure (see Dockerfile deps-* stages);
# this keeps the binaries that closure ships for other CPU/OS combinations out
# of the image. Usage: prune-native-prebuilds.sh <TARGETARCH> <node_modules dir>
set -eu

target_arch=${1:?usage: prune-native-prebuilds.sh <amd64|arm64> <node_modules>}
node_modules=${2:?usage: prune-native-prebuilds.sh <amd64|arm64> <node_modules>}

case "$target_arch" in
  amd64) swc_arch=x64; napi_arch=x64; bridge_arch=x86_64; pty_arch=x64 ;;
  arm64) swc_arch=arm64; napi_arch=arm64; bridge_arch=aarch64; pty_arch=arm64 ;;
  *) echo "prune-native-prebuilds.sh: unsupported TARGETARCH: $target_arch" >&2; exit 1 ;;
esac

prune() {
  # prune <dir> <keep-name> <glob> — remove first-level children matching glob except keep-name.
  directory=$1
  keep=$2
  pattern=$3
  [ -d "$directory" ] || return 0
  for child in "$directory"/$pattern; do
    [ -e "$child" ] || continue
    case "$(basename "$child")" in
      "$keep") ;;
      *) rm -rf "$child" ;;
    esac
  done
}

# @swc/core and @napi-rs/canvas ship per-platform native binaries as sibling
# packages; only the current platform's glibc variant can run here (Debian).
prune "$node_modules/@swc" "core-linux-${swc_arch}-gnu" 'core-*'
prune "$node_modules/@napi-rs" "canvas-linux-${napi_arch}-gnu" 'canvas-*'
# @temporalio/core-bridge ships one prebuilt bridge per OS/CPU.
prune "$node_modules/@temporalio/core-bridge/releases" "${bridge_arch}-unknown-linux-gnu" '*'
# node-pty ships prebuilds for darwin/win32; on Linux the module builds from
# source during npm ci (build-essential is installed in the build stage).
prune "$node_modules/node-pty/prebuilds" "linux-${pty_arch}" '*'
