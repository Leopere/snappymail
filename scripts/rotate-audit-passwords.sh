#!/bin/sh
set -eu

if [ "${1:-}" != "--yes" ]; then
	echo "Refusing to rotate QA passwords without --yes." >&2
	exit 2
fi

audit_env=/Users/aedev/.config/codex/snappymail-miab-audit-users.env
admin=/Users/aedev/.codex/skills/mailinabox-admin/scripts/miab-admin

if [ ! -r "$audit_env" ]; then
	echo "Missing audit account environment: $audit_env" >&2
	exit 2
fi

. "$audit_env"

"$admin" set-password snappyqa-rotate@boompay.ca "$SNAPPYMAIL_AUDIT_BOOMPAY_B_PASSWORD"
"$admin" set-password snappyqa-rotate@nixc.us "$SNAPPYMAIL_AUDIT_NIXC_B_PASSWORD"

echo "QA rotation passwords updated."
