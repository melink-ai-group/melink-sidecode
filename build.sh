#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$script_dir"

if [ ! -f package.json ]; then
  echo "error: package.json not found in $script_dir" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' was not found on PATH." >&2
  echo "Install Node.js 20 or newer (see README) and try again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: 'npm' was not found on PATH." >&2
  echo "Install Node.js 20 or newer (see README) and try again." >&2
  exit 1
fi

clean=0
for arg in "$@"; do
  case "$arg" in
    --clean | -clean) clean=1 ;;
    *)
      echo "error: unknown option: $arg" >&2
      echo "usage: ./build.sh [--clean]" >&2
      exit 2
      ;;
  esac
done

if [ "$clean" -eq 1 ] || [ ! -d node_modules ]; then
  echo "==> npm install"
  npm install
else
  echo "==> node_modules present; skipping npm install (use --clean to force)"
fi

echo "==> npm run build"
npm run build

echo "==> npm run package"
npm run package

vsix="$(ls -1t ./*.vsix 2>/dev/null | head -n 1 || true)"
if [ -n "$vsix" ]; then
  echo "==> created ${vsix#./}"
fi
