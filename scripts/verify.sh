#!/usr/bin/env bash
# Copyright © 2026 ColinKnapp.com. All rights reserved.
set -euo pipefail

source_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$source_root"

command -v yarn >/dev/null 2>&1 || {
  printf 'verify: yarn is required to install locked dependencies\n' >&2
  exit 1
}
# Existing node_modules may predate a security update to yarn.lock.
yarn install --frozen-lockfile --non-interactive

if ! node -e 'process.exit(require("fs").existsSync(require("playwright").chromium.executablePath()) ? 0 : 1)'; then
  ./node_modules/.bin/playwright install chromium
fi

npm run test:static-build
npm run check
npm run test:security

# Mirror the daily Jenkins source scan before anything is pushed: block
# tracked secrets and fixable HIGH/CRITICAL dependency vulnerabilities.
# Unfixed advisories and the documented production root-user misconfiguration
# stay with the daily report rather than blocking every release.
if command -v trivy >/dev/null 2>&1; then
  trivy fs --quiet --exit-code 1 \
    --scanners vuln,secret --severity HIGH,CRITICAL --ignore-unfixed \
    --skip-dirs .git --skip-dirs node_modules --skip-dirs tmp --skip-dirs test-results \
    --skip-dirs build/local --skip-dirs build/dist --skip-dirs build/tmp \
    --skip-files .env .
elif [ "${SNAPPYMAIL_SKIP_TRIVY:-}" = 1 ]; then
  printf 'verify: WARNING trivy is not installed; source secret and vulnerability gate skipped\n' >&2
else
  printf 'verify: trivy is required for the source secret and vulnerability gate (set SNAPPYMAIL_SKIP_TRIVY=1 to bypass)\n' >&2
  exit 1
fi
