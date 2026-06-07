#!/bin/zsh
set -e

cd "$(dirname "$0")"

export PATH="$PWD/.tooling/node/bin:$PATH"

if [ ! -x "$PWD/.tooling/node/bin/npm" ]; then
  echo "Missing local Node.js. Please run the dependency setup in README.md first."
  exit 1
fi

npm run tauri:dev
