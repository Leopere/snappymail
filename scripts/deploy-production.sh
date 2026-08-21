#!/usr/bin/env bash
# Copyright © 2026 ColinKnapp.com. All rights reserved.
#
# Build one immutable SnappyMail image, bind it to the tracked production
# controller, deploy it, and require the controller's live acceptance checks.
set -euo pipefail
umask 077

fail() {
  printf 'deploy-production: %s\n' "$*" >&2
  exit 1
}

require_var() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "$name is required"
}

require_var DEPLOY_IT_COMMIT
require_var DEPLOY_IT_ENVIRONMENT
[ "$DEPLOY_IT_ENVIRONMENT" = production ] || fail 'DEPLOY_IT_ENVIRONMENT must be production'
[[ "$DEPLOY_IT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail 'DEPLOY_IT_COMMIT must be one full lowercase Git commit ID'

source_root="$(cd "$(dirname "$0")/.." && pwd)"
controller_root="${HOME:?}/.local/share/boompay-vps-infra-l2-production-controller"
controller_env="$controller_root/.env"
gh_config_dir="${HOME:?}/.config/gh"
ship_it_bin="${SHIP_IT_BIN:-${HOME:?}/.local/bin/ship-it}"
registry=ghcr.io/leopere/boompay-snappymail
tag="$registry:git-$DEPLOY_IT_COMMIT"

[ -d "$controller_root/.git" ] && [ ! -L "$controller_root" ] || fail 'tracked production controller is unavailable'
[ -f "$controller_env" ] && [ ! -L "$controller_env" ] || fail 'production controller environment is unavailable'
[ -d "$gh_config_dir" ] && [ ! -L "$gh_config_dir" ] || fail 'GitHub CLI configuration is unavailable'
[ -x "$ship_it_bin" ] || fail 'ship-it is unavailable'
for executable in docker gh python3 curl; do
  command -v "$executable" >/dev/null 2>&1 || fail "$executable is required"
done

docker_config="$(mktemp -d)"
metadata="$(mktemp)"
cleanup() {
  DOCKER_CONFIG="$docker_config" docker logout ghcr.io >/dev/null 2>&1 || true
  rm -f "$metadata"
  find "$docker_config" -type f -delete 2>/dev/null || true
  find "$docker_config" -depth -type d -exec rmdir {} \; 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

GH_CONFIG_DIR="$gh_config_dir" gh auth token |
  DOCKER_CONFIG="$docker_config" docker login ghcr.io -u Leopere --password-stdin >/dev/null

DOCKER_CONFIG="$docker_config" docker buildx build \
  --platform linux/amd64 \
  --file "$source_root/.docker/release/Dockerfile" \
  --build-arg "SOURCE_REVISION=$DEPLOY_IT_COMMIT" \
  --tag "$tag" \
  --metadata-file "$metadata" \
  --push \
  "$source_root"

digest="$(python3 - "$metadata" <<'PY'
import json
import re
import sys

value = json.load(open(sys.argv[1], encoding="utf-8")).get("containerimage.digest", "")
if not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
    raise SystemExit("deploy-production: build metadata did not contain one immutable image digest")
print(value)
PY
)"
image="$registry@$digest"
DOCKER_CONFIG="$docker_config" docker buildx imagetools inspect "$image" >/dev/null

(
  cd "$controller_root"
  "$ship_it_bin" start
  ./scripts/set-snappymail-release.py \
    --image "$image" \
    --image-id "$digest" \
    --source "$DEPLOY_IT_COMMIT"
  ./scripts/verify.sh
  BOOMPAY_INFRA_ROOT="$controller_root" \
  BOOMPAY_ENV_FILE="$controller_env" \
  BOOMPAY_IDENTITY_LIFECYCLE=none \
  BOOMPAY_APPLICATION_RELEASE=snappymail \
  GH_CONFIG_DIR="$gh_config_dir" \
    "$ship_it_bin"
)

curl --fail --silent --show-error --max-time 20 https://mail.boompay.ca/ >/dev/null
printf 'SnappyMail production accepted source=%s image=%s\n' "$DEPLOY_IT_COMMIT" "$image"
