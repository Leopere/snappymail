#!/usr/bin/env bash
# Copyright © 2026 ColinKnapp.com. All rights reserved.
# Delegate a paired production release to the trusted local Jenkins controller.
set -euo pipefail
umask 077

fail() { printf 'deploy-production: %s\n' "$*" >&2; exit 1; }
require_var() { [ -n "${!1:-}" ] || fail "$1 is required"; }

require_var DEPLOY_IT_COMMIT
require_var DEPLOY_IT_ENVIRONMENT
[ "$DEPLOY_IT_ENVIRONMENT" = production ] || fail 'DEPLOY_IT_ENVIRONMENT must be production'
[[ "$DEPLOY_IT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail 'DEPLOY_IT_COMMIT must be one full lowercase Git commit ID'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required'

source_root="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$source_root/scripts/jenkins-release.py" "$DEPLOY_IT_COMMIT"
