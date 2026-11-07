#!/usr/bin/env bash
# Copyright © 2026 ColinKnapp.com. All rights reserved.
# Delegate a paired production release to the trusted local Jenkins controller.
set -euo pipefail
umask 077

fail() { printf 'deploy-production: %s\n' "$*" >&2; exit 1; }
source_root="$(cd "$(dirname "$0")/.." && pwd)"
branch="$(git -C "$source_root" symbolic-ref --quiet --short HEAD)"
[[ "$branch" == master ]] || fail 'Run this command from the existing master branch.'
revision="$(git -C "$source_root" rev-parse HEAD)"
remote_line="$(git -C "$source_root" ls-remote --exit-code origin refs/heads/master)"
[[ "$revision" =~ ^[0-9a-f]{40}$ && "${remote_line%%$'\t'*}" == "$revision" ]] || fail 'Push this exact master revision before submitting to Jenkins.'
export DEPLOY_IT_COMMIT="$revision" DEPLOY_IT_BRANCH="$branch"
export DEPLOY_IT_ENVIRONMENT=production DEPLOY_IT_REPO_ROOT="$source_root"
command -v python3 >/dev/null 2>&1 || fail 'python3 is required'

exec python3 "$source_root/scripts/jenkins-release.py" "$DEPLOY_IT_COMMIT"
