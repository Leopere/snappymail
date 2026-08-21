#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const values = new Map();
let apply = false;

for (let index = 2; index < process.argv.length; index++) {
	const argument = process.argv[index];
	if ('--apply' === argument) {
		apply = true;
	} else if (argument.startsWith('--') && process.argv[index + 1]) {
		values.set(argument.slice(2), process.argv[++index]);
	} else {
		console.error(`Unknown argument: ${argument}`);
		process.exit(2);
	}
}

const host = values.get('host');
const user = values.get('user');
const folder = values.get('folder') || 'Smart.Newsletters';

if (!host || !user || /[\x00-\x1f\x7f]/u.test(host + user + folder)) {
	console.error('Usage: install-newsletter-sieve.mjs --host <ssh-host> --user <email> [--folder <mailbox>] [--apply]');
	process.exit(2);
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendered = spawnSync(process.execPath, [
	path.join(directory, 'newsletter-sieve.mjs'),
	'render',
	folder
], { encoding: 'utf8' });

if (rendered.status) {
	process.stderr.write(rendered.stderr);
	process.exit(rendered.status);
}

const ruleMarker = '# BEGIN SNAPPYMAIL MANAGED NEWSLETTER SORTING';
const ruleStart = rendered.stdout.indexOf(ruleMarker);
if (-1 === ruleStart) {
	console.error('Generated Sieve rule is missing its managed marker');
	process.exit(1);
}

const requirements = rendered.stdout.slice(0, ruleStart).trimEnd();
const rule = rendered.stdout.slice(ruleStart).trim();
const base64 = value => Buffer.from(value, 'utf8').toString('base64');
const shell = value => `'${value.replace(/'/g, `'\\''`)}'`;
const message = (subject, listHeader = '') => [
	'From: sorting-test@example.test',
	`To: ${user}`,
	`Subject: ${subject}`,
	listHeader,
	`Message-ID: <sorting-${Math.random().toString(16).slice(2)}@example.test>`,
	'MIME-Version: 1.0',
	'Content-Type: text/plain',
	'',
	'Managed sorting test.',
	''
].filter((line, index) => line || 7 <= index).join('\n');

const remote = `set -eu
user=${shell(user)}
folder=${shell(folder)}
apply=${apply ? 1 : 0}
requirements=${shell(base64(requirements + '\n\n'))}
rule=${shell(base64(rule + '\n'))}
positive_message=${shell(base64(message('Weekly engineering digest', 'List-Unsubscribe: <mailto:unsubscribe@example.test>')))}
finance_message=${shell(base64(message('Invoice available - payment due', 'List-Unsubscribe: <mailto:unsubscribe@example.test>')))}
personal_message=${shell(base64(message('Dinner tomorrow')))}
active=$(sudo doveadm sieve list -u "$user" | awk '$2 == "ACTIVE" { print $1; exit }')
test -n "$active"
current=$(mktemp)
clean=$(mktemp)
candidate=$(mktemp)
compiled=$(mktemp)
positive=$(mktemp)
finance=$(mktemp)
personal=$(mktemp)
trap 'rm -f "$current" "$clean" "$candidate" "$compiled" "$positive" "$finance" "$personal"' EXIT
sudo doveadm sieve get -u "$user" "$active" | sed '1d' > "$current"
sed '/^# BEGIN SNAPPYMAIL MANAGED SORTING REQUIREMENTS$/,/^# END SNAPPYMAIL MANAGED SORTING REQUIREMENTS$/d; /^# BEGIN SNAPPYMAIL MANAGED NEWSLETTER SORTING$/,/^# END SNAPPYMAIL MANAGED NEWSLETTER SORTING$/d' "$current" |
	perl -0777 -pe 's/\\A\\s+//; s/\\s+\\z/\\n/' > "$clean"
printf '%s' "$requirements" | base64 -d > "$candidate"
cat "$clean" >> "$candidate"
printf '\\n' >> "$candidate"
printf '%s' "$rule" | base64 -d >> "$candidate"
sievec "$candidate" "$compiled"
printf '%s' "$positive_message" | base64 -d > "$positive"
printf '%s' "$finance_message" | base64 -d > "$finance"
printf '%s' "$personal_message" | base64 -d > "$personal"
chmod a+r "$candidate" "$positive" "$finance" "$personal"
set +e
positive_result=$(sudo -u mail sieve-test "$candidate" "$positive" 2>&1)
positive_status=$?
finance_result=$(sudo -u mail sieve-test "$candidate" "$finance" 2>&1)
finance_status=$?
personal_result=$(sudo -u mail sieve-test "$candidate" "$personal" 2>&1)
personal_status=$?
set -e
if [ "$positive_status" != 0 ] || [ "$finance_status" != 0 ] || [ "$personal_status" != 0 ]; then
	printf '%s\\n%s\\n%s\\n' "$positive_result" "$finance_result" "$personal_result" >&2
	exit 1
fi
printf '%s' "$positive_result" | grep -Fq "$folder"
! printf '%s' "$finance_result" | grep -Fq "$folder"
! printf '%s' "$personal_result" | grep -Fq "$folder"
printf 'active=%s\\ncandidate_sha256=' "$active"
sha256sum "$candidate" | awk '{print $1}'
printf 'positive=newsletter\\nfinance=excluded\\npersonal=unmatched\\n'
if [ "$apply" != 1 ]; then
	printf 'status=dry-run\\n'
	exit 0
fi
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
safe_user=$(printf '%s' "$user" | tr -c 'A-Za-z0-9._-' '_')
safe_active=$(printf '%s' "$active" | tr -c 'A-Za-z0-9._-' '_')
sudo mkdir -p /root/snappymail-sieve-backups
backup="/root/snappymail-sieve-backups/$safe_user-$safe_active-$timestamp.sieve.bak"
sudo install -m 600 "$current" "$backup"
if ! sudo doveadm mailbox list -u "$user" | grep -Fxq "$folder"; then
	sudo doveadm mailbox create -s -u "$user" "$folder"
fi
sudo doveadm mailbox subscribe -u "$user" "$folder"
sudo doveadm sieve put -a -u "$user" "$active" < "$candidate"
installed=$(sudo doveadm sieve get -u "$user" "$active" | sed '1d' | sha256sum | awk '{print $1}')
expected=$(sha256sum "$candidate" | awk '{print $1}')
test "$installed" = "$expected"
sudo doveadm mailbox list -u "$user" | grep -Fxq "$folder"
sudo doveadm sieve list -u "$user" | grep -Fq "$active ACTIVE"
printf 'backup=%s\\nfolder=%s\\nstatus=installed\\n' "$backup" "$folder"
`;

const result = spawnSync('ssh', [
	'-o', 'BatchMode=yes',
	'-o', 'ConnectTimeout=15',
	host,
	'bash -s'
], {
	input: remote,
	encoding: 'utf8'
});

process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
result.error && console.error(result.error.message);
if (!result.stdout && !result.stderr && !result.error) {
	console.error(`Remote installer returned status ${result.status} without output`);
}
process.exitCode = result.status ?? 1;
