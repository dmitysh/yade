#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then
  printf '%s\n' 'Сборка и установка доступны только на macOS.' >&2
  exit 1
fi

npm ci
npm run desktop:build
npm run desktop:check

if pgrep -x yade >/dev/null; then
  printf '%s\n' 'Завершите Yade через Cmd+Q и повторите установку.' >&2
  exit 1
fi

directory="${1:-/Applications}"
destination="$directory/Yade.app"
mkdir -p "$directory"
staging="$(mktemp -d "$directory/.yade-install.XXXXXX")"
cleanup() {
  if [[ -e "$staging/previous.app" && ! -e "$destination" ]]; then
    if ! mv "$staging/previous.app" "$destination"; then
      printf 'Не удалось вернуть прежнее приложение. Оно сохранено: %s\n' "$staging/previous.app" >&2
      return
    fi
  fi
  rm -rf "$staging"
}
trap cleanup EXIT

ditto src-tauri/target/release/bundle/macos/Yade.app "$staging/Yade.app"
if [[ -e "$destination" ]]; then
  mv "$destination" "$staging/previous.app"
fi
mv "$staging/Yade.app" "$destination"
printf 'Приложение установлено: %s\n' "$destination"
