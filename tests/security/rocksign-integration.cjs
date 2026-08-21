const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const test = path.join(root, 'tests/php/rocksign-integration.php');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const assert = (condition, message) => {
	if (!condition) throw Error(message);
};

const plugin = read('plugins/rocksign/index.php');
const client = read('plugins/rocksign/RockSignClient.php');
const browser = read('plugins/rocksign/js/rocksign.js');
const admin = read('plugins/rocksign/js/admin.js');
const readme = read('plugins/rocksign/README');
const dockerfile = read('.docker/release/Dockerfile');
const entrypoint = read('.docker/release/files/entrypoint.sh');
const compose = read('docker-compose.yml');
const wkdDiscovery = read('snappymail/v/0.0.0/app/libraries/snappymail/pgp/keyservers.php');
const wkd = read('snappymail/v/0.0.0/app/libraries/snappymail/pgp/wkd.php');

assert(
	plugin.includes("NewInstance('api_token')")
		&& plugin.includes('PluginPropertyType::PASSWORD')
		&& plugin.includes('->SetEncrypted()')
		&& !plugin.includes('SetAllowedInJs'),
	'The RockSign token must be an encrypted admin-only password property.'
);
assert(
	client.includes("BASE_URL = 'https://sign.boompay.ca'")
		&& client.includes('$request->verify_peer = true')
		&& client.includes('$request->max_redirects = 0')
		&& client.includes("'X-Auth-Token: ' . $this->token"),
	'RockSign calls must use the fixed verified-TLS origin without redirects and keep authentication server-side.'
);
assert(
	plugin.includes("$this->addJsonHook('RockSignCreateSubmission'")
		&& plugin.includes("$this->addJsonHook('RockSignCertifyPdf'")
		&& plugin.includes("$this->addJsonHook('RockSignAttachCompletedPdf'")
		&& plugin.includes("$this->addJsonHook('RockSignVerifyPdf'")
		&& plugin.includes('requireAuthorizedAccount()')
		&& plugin.includes('requireAllowedTemplateId'),
	'Every requested workflow must exist behind mailbox and template authorization.'
);
assert(
	!plugin.includes('GetFileName($account, $tempName)')
		&& plugin.includes("jsonParam('filename'"),
	'PDF display names must be sanitized from the Compose attachment name, not leaked from the private storage path.'
);
assert(
	plugin.includes("hash_hmac('sha256'")
		&& plugin.includes('ownsSubmission(')
		&& plugin.includes('external_id')
		&& plugin.includes('rocksign-mailbox\\0')
		&& plugin.includes('external_id={$externalId}')
		&& plugin.includes('{$basePath}&after={$next}'),
	'Completed contracts must use stateless, mailbox-bound ownership proofs.'
);
assert(
	plugin.includes("return $client->json('POST', '/api/tools/verify'"),
	'Server-side PDF checks must use the authenticated verifier instead of the public per-IP rate limit.'
);
assert(
	browser.includes("rockSignOpen('request')")
		&& browser.includes("rockSignOpen('certify')")
		&& browser.includes("rockSignOpen('completed')")
		&& browser.includes("rockSignOpen('verify')"),
	'Compose must expose all four RockSign workflows through one Contracts menu.'
);
assert(
	browser.includes("pluginSettingsGet('rocksign', 'enabled')")
		&& browser.includes("pluginSettingsGet('rocksign', 'mailbox')")
		&& !browser.includes("pluginSettingsGet('RockSign'"),
	'Browser settings must use the lowercase plugin folder ID used by SnappyMail AppData.'
);
assert(
	plugin.includes('SnappyMail delivery is limited to one signer')
		&& browser.includes('compose.to(signer.email)')
		&& browser.includes("compose.cc('')")
		&& browser.includes("compose.bcc('')")
		&& browser.includes('this.finished(true)')
		&& browser.includes('was created; do not retry it')
		&& browser.includes('confirmLocalDelivery')
		&& browser.includes('undoInvitation()')
		&& plugin.includes("submitter['submission_id']")
		&& plugin.includes("submitter['external_id']")
		&& client.includes('signingUrlAllowed')
		&& browser.indexOf('this.validateRequest(submitters)') < browser.indexOf("call('RockSignCreateSubmission'"),
	'SnappyMail delivery must isolate one private signer link and prevent accidental duplicate submissions.'
);
assert(
	admin.includes('visible: rockSignTestVisible()')
		&& admin.includes('disable: rockSignTesting')
		&& plugin.includes("capabilities['create_submission']")
		&& plugin.includes("capabilities['sign_pdf']"),
	'The admin connection check must be RockSign-only, single-flight, and reject insufficient token capabilities.'
);
assert(
	client.includes('$mutation &&')
		&& client.includes('$statusUnknown')
		&& plugin.includes("2097152, true")
		&& plugin.includes('MAX_SIGN_RESPONSE_BYTES, true'),
	'Mutating requests must distinguish validation failures from transport, malformed, 5xx, and oversized unknown states.'
);
assert(
	readme.includes('`_openpgpkey.<identity-domain>` TXT')
		&& readme.includes('it never points to RockSign'),
	'RockSign service discovery must remain separate from the DNS TXT locator used for WKD.'
);
assert(
	dockerfile.includes('COPY --chown=root:root plugins/rocksign /opt/snappymail-plugins/rocksign')
		&& entrypoint.includes('ROCKSIGN_PLUGIN_NEW=')
		&& entrypoint.includes('chown -R root:root "$ROCKSIGN_PLUGIN_NEW"')
		&& entrypoint.includes('mv "$ROCKSIGN_PLUGIN_NEW" "$ROCKSIGN_PLUGIN_DIR"')
		&& entrypoint.includes('MEMORY_LIMIT=${MEMORY_LIMIT:-256M}')
		&& compose.includes('MEMORY_LIMIT=${SNAPPYMAIL_MEMORY_LIMIT:-256M}')
		&& plugin.includes("VERSION = '1.0.1'"),
	'The Docker image must atomically install root-owned RockSign code with enough PHP memory and a cache-busting version.'
);
assert(
	wkdDiscovery.includes('static::wkdManifestTxtUrls($domain)')
		&& !wkdDiscovery.includes('legacy fallback for deployments')
		&& !wkdDiscovery.includes('/index.json";'),
	'Nonstandard manifests must be discovered only through the fixed identity-domain TXT locator.'
);
assert(
	!wkd.includes("str_starts_with($domain, 'openpgpkey.')")
		&& wkd.includes('$host === $domain && $directFile')
		&& wkd.includes("$host === 'openpgpkey.' . $domain"),
	'Identity domains must remain exact and manifest keys must use exact direct or advanced WKD host/path pairings.'
);

const run = (command, args, options = {}) => childProcess.spawnSync(command, args, {
	cwd: root,
	encoding: 'utf8',
	...options
});
const print = result => {
	process.stdout.write(result.stdout || '');
	process.stderr.write(result.stderr || '');
};

let result = run(process.env.PHP_BINARY || 'php', [test]);
if (result.error?.code === 'ENOENT') {
	const image = run('docker', ['compose', 'images', '-q', 'snappymail']);
	if (image.error || !image.stdout.trim()) {
		throw Error('RockSign integration tests need PHP CLI or the local SnappyMail Docker image.');
	}
	result = run('docker', [
		'run', '--rm',
		'--volume', `${root}:/workspace:ro`,
		'--entrypoint', 'php',
		image.stdout.trim().split(/\s+/)[0],
		'/workspace/tests/php/rocksign-integration.php'
	]);
}
print(result);
if (result.error) throw result.error;
if (0 !== result.status) process.exitCode = result.status || 1;
