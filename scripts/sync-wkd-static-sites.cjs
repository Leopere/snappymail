#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const domains = [
	{ domain: 'boompay.ca', repo: path.resolve(root, '../boompay-ca') },
	{ domain: 'nixc.us', repo: path.resolve(root, '../nixc-us') }
];

const run = (cmd, args, options = {}) =>
	execFileSync(cmd, args, {
		cwd: root,
		encoding: options.encoding ?? 'utf8',
		stdio: options.stdio || ['ignore', 'pipe', 'inherit'],
		input: options.input
	});

const sh = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

const publishScript = `
set -eu

data_root=/var/lib/snappymail/_data_/_default_
storage_root="$data_root/storage"
wkd_root="$data_root/openpgpkey"

wkd_hash() {
	php -r '
		$alphabet = "ybndrfg8ejkmcpqxot1uwisza345h769";
		$bytes = sha1(strtolower(trim($argv[1])), true);
		$bits = "";
		for ($i = 0; $i < strlen($bytes); ++$i) {
			$bits .= str_pad(decbin(ord($bytes[$i])), 8, "0", STR_PAD_LEFT);
		}
		$out = "";
		for ($i = 0; $i < strlen($bits); $i += 5) {
			$out .= $alphabet[bindec(str_pad(substr($bits, $i, 5), 5, "0", STR_PAD_RIGHT))];
		}
		echo $out;
	' "$1"
}

for domain in ${domains.map(({ domain }) => sh(domain)).join(' ')}; do
	[ -d "$storage_root/$domain" ] || continue
	mkdir -p "$wkd_root/$domain/hu"

	for account_dir in "$storage_root/$domain"/*; do
		[ -d "$account_dir/.gnupg" ] || continue
		local=$(basename "$account_dir")
		email="$local@$domain"
		gnupg="$account_dir/.gnupg"

		if ! GNUPGHOME="$gnupg" gpg --batch --list-secret-keys "$email" >/dev/null 2>&1; then
			continue
		fi

		key_id=$(GNUPGHOME="$gnupg" gpg --batch --with-colons --list-secret-keys "$email" | awk -F: '
			/^sec:/ && $6 >= created {
				created = $6;
				key_id = $5;
			}
			END {
				print key_id;
			}
		')
		[ -n "$key_id" ] || continue

		hash=$(wkd_hash "$local")
		tmp=$(mktemp)
		trap 'rm -f "$tmp"' EXIT
		GNUPGHOME="$gnupg" gpg --batch --yes --armor --export "$key_id" > "$tmp"
		gpg --batch --yes --dearmor --output "$wkd_root/$domain/hu/$hash" "$tmp"
		chown www-data:www-data "$wkd_root/$domain/hu/$hash" 2>/dev/null || true
		chmod 600 "$wkd_root/$domain/hu/$hash"
		rm -f "$tmp"
		trap - EXIT
	done
done

cd "$wkd_root"
tar -cf - ${domains.map(({ domain }) => sh(domain)).join(' ')}
`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snappymail-wkd-'));
try {
	const archive = run('docker', ['compose', 'exec', '-T', 'snappymail', 'sh', '-lc', publishScript], { encoding: 'buffer' });
	const tar = spawnSync('tar', ['-xf', '-', '-C', tmpRoot], { input: archive, stdio: ['pipe', 'inherit', 'inherit'] });
	if (tar.status) {
		process.exit(tar.status);
	}

	for (const { domain, repo } of domains) {
		const source = path.join(tmpRoot, domain, 'hu');
		if (!fs.existsSync(source)) {
			console.log(`No WKD keys found for ${domain}`);
			continue;
		}

		for (const rootName of ['.', 'docs']) {
			const targetRoot = path.join(repo, rootName, '.well-known', 'openpgpkey');
			fs.rmSync(targetRoot, { recursive: true, force: true });
			fs.mkdirSync(path.join(targetRoot, 'hu'), { recursive: true });
			fs.mkdirSync(path.join(targetRoot, domain, 'hu'), { recursive: true });
			fs.writeFileSync(path.join(targetRoot, 'policy'), '');
			fs.writeFileSync(path.join(targetRoot, domain, 'policy'), '');

			for (const file of fs.readdirSync(source)) {
				const from = path.join(source, file);
				if (!fs.statSync(from).isFile()) {
					continue;
				}
				fs.copyFileSync(from, path.join(targetRoot, 'hu', file));
				fs.copyFileSync(from, path.join(targetRoot, domain, 'hu', file));
			}
		}

		console.log(`Synced WKD key files for ${domain} to ${repo}`);
	}
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}
