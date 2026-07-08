#!/usr/bin/env node

const { execFileSync } = require('child_process');

const miabAdmin = process.env.MIAB_ADMIN_HELPER
	|| '/Users/aedev/.codex/skills/mailinabox-admin/scripts/miab-admin';
const sshHost = process.env.SNAPPYMAIL_SSH_HOST || 'box.p.nixc.us';
const storageRoot = process.env.SNAPPYMAIL_STORAGE_ROOT || '/var/lib/snappymail/_data_/_default_/storage';
const runUser = process.env.SNAPPYMAIL_RUN_USER || 'www-data';
const domain = process.argv[2] || process.env.SNAPPYMAIL_GNUPG_DOMAIN || 'nixc.us';

const sh = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

const run = (cmd, args, options = {}) =>
	execFileSync(cmd, args, {
		encoding: 'utf8',
		stdio: options.stdio || ['ignore', 'pipe', 'inherit'],
		input: options.input
	});

const usersJson = run(miabAdmin, ['users']);
const users = JSON.parse(usersJson)
	.find(group => group.domain === domain)
	?.users
	?.filter(user => user.status === 'active')
	?.map(user => user.email)
	?.sort();

if (!users?.length) {
	console.error(`No active Mail-in-a-Box users found for ${domain}`);
	process.exit(1);
}

const script = String.raw`
set -eu

storage_root=__STORAGE_ROOT__
run_user=__RUN_USER__
domain=__DOMAIN__
users=__USERS__
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for email in $users; do
	local=\${email%@*}
	gnupg="$storage_root/$domain/$local/.gnupg"
	mkdir -p "$gnupg"
	chown -R "$run_user:$run_user" "$storage_root/$domain/$local"
	chmod 700 "$gnupg"

	if ! sudo -u "$run_user" env GNUPGHOME="$gnupg" gpg --batch --list-secret-keys "$email" >/dev/null 2>&1; then
		cat > "$tmp/key-$local.conf" <<EOF
Key-Type: default
Subkey-Type: default
Name-Email: $email
Expire-Date: 0
%no-protection
%commit
EOF
		sudo -u "$run_user" env GNUPGHOME="$gnupg" gpg --batch --generate-key "$tmp/key-$local.conf"
	fi

	sudo -u "$run_user" env GNUPGHOME="$gnupg" gpg --batch --yes --armor --export "$email" > "$tmp/$local.asc"
done

for email in $users; do
	local=\${email%@*}
	gnupg="$storage_root/$domain/$local/.gnupg"
	for key in "$tmp"/*.asc; do
		sudo -u "$run_user" env GNUPGHOME="$gnupg" gpg --batch --yes --import "$key" >/dev/null
	done
done
`;

const remoteScript = script
	.replace('__STORAGE_ROOT__', sh(storageRoot))
	.replace('__RUN_USER__', sh(runUser))
	.replace('__DOMAIN__', sh(domain))
	.replace('__USERS__', users.map(sh).join(' '));

console.log(`Provisioning server-managed GnuPG keys for ${users.length} active ${domain} mailbox(es) on ${sshHost}`);
run('ssh', [sshHost, 'sh', '-lc', remoteScript], { stdio: 'inherit' });
console.log('Done. Each active same-domain mailbox now has a server GnuPG keyring and same-domain public keys imported.');
