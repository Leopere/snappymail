#!/usr/bin/env bash
# Copyright © 2026 ColinKnapp.com. All rights reserved.
set -euo pipefail

source_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$source_root"

if [ ! -d node_modules ]; then
  command -v yarn >/dev/null 2>&1 || {
    printf 'verify: yarn is required when node_modules is missing\n' >&2
    exit 1
  }
  yarn install --frozen-lockfile --non-interactive
fi

if ! node -e 'process.exit(require("fs").existsSync(require("playwright").chromium.executablePath()) ? 0 : 1)'; then
  ./node_modules/.bin/playwright install chromium
fi

npm run test:static-build
npm run check
npm run test:security
