#!/usr/bin/env node

const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CONFIRMATION = 'SCRUB_BROWSER_OPENPGP_KEYS';
const STORAGE_ROOT = '/var/lib/snappymail/_data_/_default_/storage';
const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

const CUTOVER_ACCOUNTS = Object.freeze([
	{ email: 'mike.lefler@boompay.ca', passwordEnv: 'SNAPPYMAIL_CUTOVER_MIKE_LEFLER_PASSWORD' },
	{ email: 'mike.mcarthur@boompay.ca', passwordEnv: 'SNAPPYMAIL_CUTOVER_MIKE_MCARTHUR_PASSWORD' },
	{ email: 'kevin.haywood@boompay.ca', passwordEnv: 'SNAPPYMAIL_CUTOVER_KEVIN_HAYWOOD_PASSWORD' },
	{ email: 'colin.knapp@boompay.ca', passwordEnv: 'SNAPPYMAIL_CUTOVER_COLIN_KNAPP_PASSWORD' },
	{ email: 'colin@nixc.us', passwordEnv: 'SNAPPYMAIL_CUTOVER_COLIN_NIXC_PASSWORD' }
]);

const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

const wkdHash = local => {
	const bytes = crypto.createHash('sha1').update(String(local).trim().toLowerCase()).digest();
	let buffer = 0, bits = 0, result = '';
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (5 <= bits) {
			bits -= 5;
			result += ZBASE32[(buffer >> bits) & 31];
		}
	}
	if (bits) {
		result += ZBASE32[(buffer << (5 - bits)) & 31];
	}
	return result;
};

const accountRows = () => CUTOVER_ACCOUNTS.map(account => {
	const [local, domain] = account.email.split('@');
	return {
		email: account.email,
		local,
		domain,
		wkdHash: wkdHash(local),
		emailHash: crypto.createHash('sha256').update(account.email).digest('hex')
	};
});

const parseOptions = (argv = process.argv.slice(2)) => {
	let mode = 'plan', confirmation = '';
	for (let index = 0; index < argv.length; index += 1) {
		switch (argv[index]) {
			case '--execute':
				if ('verify' === mode) {
					throw Error('Use either --execute or --verify, not both.');
				}
				mode = 'execute';
				break;
			case '--verify':
				if ('execute' === mode) {
					throw Error('Use either --execute or --verify, not both.');
				}
				mode = 'verify';
				break;
			case '--confirm':
				confirmation = argv[++index] || '';
				break;
			case '--help':
				return { help: true, mode: 'plan', confirmation: '' };
			default:
				throw Error(`Unknown option: ${argv[index]}`);
		}
	}
	if ('execute' === mode && CONFIRMATION !== confirmation) {
		throw Error(`Refusing to scrub keys without --confirm ${CONFIRMATION}`);
	}
	return { help: false, mode, confirmation };
};

const help = () => {
	console.log(`Usage:
  node scripts/openpgp-clean-cutover.cjs
  node scripts/openpgp-clean-cutover.cjs --execute --confirm ${CONFIRMATION}
  node scripts/openpgp-clean-cutover.cjs --verify

The default is a read-only plan. --execute removes only the browser-vault,
legacy OpenPGP artifacts, matching WKD entries, and active sessions for the
five named clean-cutover accounts. It never touches mail, account settings,
branding, or tunnel clients.`);
};

const buildRemoteScript = mode => {
	const accounts = Buffer.from(JSON.stringify(accountRows())).toString('base64');
	return `set -eu
export SNAPPYMAIL_CUTOVER_MODE=${shellQuote(mode)}
export SNAPPYMAIL_CUTOVER_STORAGE_ROOT=${shellQuote(STORAGE_ROOT)}
export SNAPPYMAIL_CUTOVER_ACCOUNTS_B64=${shellQuote(accounts)}
php <<'PHP'
<?php
declare(strict_types=1);

function cutoverFail(string $message) : void
{
	fwrite(STDERR, "OpenPGP cutover: {$message}\\n");
	exit(2);
}

function cutoverExists(string $path) : bool
{
	return is_file($path) || is_dir($path) || is_link($path);
}

function cutoverRemove(string $path) : bool
{
	if (is_link($path) || is_file($path)) {
		return @unlink($path);
	}
	if (!is_dir($path)) {
		return true;
	}
	foreach (scandir($path) ?: [] as $entry) {
		if ('.' !== $entry && '..' !== $entry && !cutoverRemove($path . '/' . $entry)) {
			return false;
		}
	}
	return @rmdir($path);
}

function cutoverManifest(string $path) : array
{
	if (!is_file($path)) {
		return ['exists' => false, 'data' => ['entries' => []]];
	}
	$data = json_decode((string) file_get_contents($path), true);
	if (!is_array($data) || !is_array($data['entries'] ?? null)) {
		cutoverFail("refusing to modify malformed WKD manifest {$path}");
	}
	return ['exists' => true, 'data' => $data];
}

function cutoverWriteManifest(string $path, array $manifest, array $removedHashes) : bool
{
	if (!is_file($path)) {
		return true;
	}
	$manifest['entries'] = array_values(array_filter($manifest['entries'], static function ($entry) use ($removedHashes) : bool {
		return !is_array($entry) || !isset($removedHashes[strtolower((string) ($entry['email_hash'] ?? ''))]);
	}));
	$manifest['generated_at'] = gmdate('c');
	$temp = tempnam(dirname($path), '.openpgp-cutover-');
	if (!$temp) {
		return false;
	}
	try {
		$written = false !== file_put_contents($temp, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\\n", LOCK_EX);
		return $written && rename($temp, $path);
	} finally {
		is_file($temp) && @unlink($temp);
	}
}

function cutoverVaultState(string $path) : array
{
	if (!is_file($path)) {
		return ['present' => false, 'valid' => false, 'privateArmor' => false];
	}
	$raw = (string) file_get_contents($path);
	$record = json_decode($raw, true);
	$valid = is_array($record)
		&& 2 === ($record['version'] ?? 0)
		&& 0 < (int) ($record['revision'] ?? 0)
		&& is_array($record['vault'] ?? null)
		&& is_string($record['publicKey'] ?? null)
		&& str_contains($record['publicKey'], 'BEGIN PGP PUBLIC KEY BLOCK');
	return [
		'present' => true,
		'valid' => $valid,
		'privateArmor' => str_contains($raw, 'BEGIN PGP PRIVATE KEY')
	];
}

$mode = getenv('SNAPPYMAIL_CUTOVER_MODE') ?: '';
$storageRoot = getenv('SNAPPYMAIL_CUTOVER_STORAGE_ROOT') ?: '';
$expectedStorageRoot = '/var/lib/snappymail/_data_/_default_/storage';
if (!in_array($mode, ['plan', 'execute', 'verify'], true) || !hash_equals($expectedStorageRoot, $storageRoot)) {
	cutoverFail('invalid runtime configuration');
}

try {
	$accounts = json_decode((string) base64_decode((string) getenv('SNAPPYMAIL_CUTOVER_ACCOUNTS_B64'), true), true, 512, JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
	cutoverFail('invalid account payload');
}
if (!is_array($accounts) || 5 !== count($accounts)) {
	cutoverFail('the exact five-account cutover list is required');
}

$dataRoot = dirname($storageRoot);
$artifacts = ['.openpgp-client-vault', '.gnupg-passphrases', '.gnupg', '.pgp', '.sessions'];
$byDomain = [];
$prepared = [];
foreach ($accounts as $account) {
	$email = strtolower((string) ($account['email'] ?? ''));
	$local = strtolower((string) ($account['local'] ?? ''));
	$domain = strtolower((string) ($account['domain'] ?? ''));
	$wkdHash = strtolower((string) ($account['wkdHash'] ?? ''));
	$emailHash = strtolower((string) ($account['emailHash'] ?? ''));
	if (!preg_match('/^[a-z0-9][a-z0-9._+-]*$/', $local)
		|| !preg_match('/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/', $domain)
		|| $email !== $local . '@' . $domain
		|| !preg_match('/^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/', $wkdHash)
		|| !hash_equals(hash('sha256', $email), $emailHash)) {
		cutoverFail('invalid account scope');
	}
	$root = $storageRoot . '/' . $domain . '/' . $local;
	$wkdPath = $dataRoot . '/openpgpkey/' . $domain . '/hu/' . $wkdHash;
	$manifestPath = $dataRoot . '/openpgpkey/' . $domain . '/index.json';
	$prepared[] = compact('email', 'local', 'domain', 'root', 'wkdPath', 'manifestPath', 'emailHash');
	$byDomain[$domain][] = $emailHash;
}

$manifests = [];
foreach ($byDomain as $domain => $hashes) {
	$manifests[$domain] = cutoverManifest($dataRoot . '/openpgpkey/' . $domain . '/index.json');
}

$state = static function (array $account) use ($artifacts, &$manifests) : array {
	$artifactState = [];
	foreach ($artifacts as $artifact) {
		$artifactState[$artifact] = cutoverExists($account['root'] . '/' . $artifact);
	}
	$entries = $manifests[$account['domain']]['data']['entries'];
	$manifestEntry = false;
	foreach ($entries as $entry) {
		if (is_array($entry) && hash_equals($account['emailHash'], strtolower((string) ($entry['email_hash'] ?? '')))) {
			$manifestEntry = true;
			break;
		}
	}
	return [
		'email' => $account['email'],
		'artifacts' => $artifactState,
		'wkdObject' => cutoverExists($account['wkdPath']),
		'manifestEntry' => $manifestEntry,
		'vault' => cutoverVaultState($account['root'] . '/.openpgp-client-vault')
	];
};

if ('execute' === $mode) {
	foreach ($prepared as $account) {
		if (is_link($account['root'])) {
			cutoverFail('refusing to traverse a linked mailbox storage directory');
		}
		foreach ($artifacts as $artifact) {
			$path = $account['root'] . '/' . $artifact;
			if (!cutoverRemove($path)) {
				cutoverFail("unable to remove {$artifact} for {$account['email']}");
			}
		}
		if (!cutoverRemove($account['wkdPath'])) {
			cutoverFail("unable to remove WKD object for {$account['email']}");
		}
	}
	foreach ($byDomain as $domain => $hashes) {
		if (!cutoverWriteManifest(
			$dataRoot . '/openpgpkey/' . $domain . '/index.json',
			$manifests[$domain]['data'],
			array_fill_keys($hashes, true)
		)) {
			cutoverFail("unable to rewrite WKD manifest for {$domain}");
		}
		$manifests[$domain] = cutoverManifest($dataRoot . '/openpgpkey/' . $domain . '/index.json');
	}
}

$result = array_map($state, $prepared);
if ('execute' === $mode) {
	foreach ($result as $account) {
		if ($account['wkdObject'] || $account['manifestEntry'] || $account['vault']['present']
			|| array_filter($account['artifacts'])) {
			cutoverFail('post-scrub verification failed for ' . $account['email']);
		}
	}
}
if ('verify' === $mode) {
	foreach ($result as $account) {
		$legacyArtifacts = $account['artifacts'];
		unset($legacyArtifacts['.openpgp-client-vault'], $legacyArtifacts['.sessions']);
		if (!$account['vault']['present'] || !$account['vault']['valid'] || $account['vault']['privateArmor']
			|| !$account['wkdObject'] || !$account['manifestEntry'] || array_filter($legacyArtifacts)) {
			cutoverFail('post-login verification failed for ' . $account['email']);
		}
	}
}

echo json_encode(['mode' => $mode, 'accounts' => $result], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\\n";
PHP`;
};

const main = () => {
	const options = parseOptions();
	if (options.help) {
		help();
		return;
	}
	execFileSync('docker', ['compose', 'exec', '-T', 'snappymail', 'sh', '-s'], {
		input: buildRemoteScript(options.mode),
		stdio: ['pipe', 'inherit', 'inherit']
	});
};

if (require.main === module) {
	try {
		main();
	} catch (error) {
		console.error(error.message || error);
		process.exitCode = 1;
	}
}

module.exports = {
	CONFIRMATION,
	CUTOVER_ACCOUNTS,
	STORAGE_ROOT,
	wkdHash,
	parseOptions,
	buildRemoteScript
};
