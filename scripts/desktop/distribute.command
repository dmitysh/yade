#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then
  printf '%s\n' 'Сборка доступна только на macOS.' >&2
  exit 1
fi

npm ci
npm run tauri -- build --bundles app,dmg
npm run desktop:check
printf 'Образ для передачи: %s/src-tauri/target/release/bundle/dmg/\n' "$PWD"
