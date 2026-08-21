#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: ./ship.sh <commit message>" >&2
  exit 1
fi

message="$*"

git add .
git commit -m "$message"
git push
