const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const {
	CONFIRMATION,
	CUTOVER_ACCOUNTS,
	STORAGE_ROOT,
	wkdHash,
	parseOptions,
	buildRemoteScript
} = require(path.join(root, 'scripts/openpgp-clean-cutover.cjs'));

assert.deepStrictEqual(
	CUTOVER_ACCOUNTS.map(account => account.email),
	[
		'mike.lefler@boompay.ca',
		'mike.mcarthur@boompay.ca',
		'kevin.haywood@boompay.ca',
		'colin.knapp@boompay.ca',
		'colin@nixc.us'
	],
	'The clean cutover must be constrained to the exact five requested accounts.'
);
assert.strictEqual(wkdHash('colin.knapp'), 'b1rn8bjo3sd3c77q5iu4zpeo1xc5eon5');
assert.strictEqual(wkdHash('colin'), 'go1sjxy4s81iny9akrnmmayuiz69okgm');
assert.throws(() => parseOptions(['--execute']), /--confirm/);
assert.throws(() => parseOptions(['--execute', '--verify']), /either --execute or --verify/);
assert.deepStrictEqual(
	parseOptions(['--execute', '--confirm', CONFIRMATION]),
	{ help: false, mode: 'execute', confirmation: CONFIRMATION }
);

const script = buildRemoteScript('execute');
for (const artifact of ['.openpgp-client-vault', '.gnupg-passphrases', '.gnupg', '.pgp', '.sessions']) {
	assert(script.includes(`'${artifact}'`), `The cutover must scrub ${artifact}.`);
}
assert(
	script.includes(STORAGE_ROOT)
		&& script.includes('openpgpkey/')
		&& script.includes('cutoverWriteManifest')
		&& script.includes('use ($artifacts, &$manifests)')
		&& script.includes('post-scrub verification failed')
		&& script.includes('post-login verification failed'),
	'Cutover cleanup must remove only matching WKD objects and manifest entries, then verify both phases.'
);
assert(
	!script.includes('rm -rf') && !script.includes('tunnel-client') && !script.includes('gpg --generate-key'),
	'Cutover cleanup must not use broad shell deletion, alter tunnels, or generate server GnuPG keys.'
);

const retiredProvisioner = read('scripts/provision-miab-domain-gnupg.cjs');
assert(
	retiredProvisioner.includes('Server-side GnuPG provisioning is retired')
		&& retiredProvisioner.includes('process.exitCode = 2')
		&& !retiredProvisioner.includes('--generate-key'),
	'Legacy Mail-in-a-Box GnuPG provisioning must fail closed rather than reintroducing server-side private keys.'
);

console.log('OpenPGP clean-cutover contract checks passed');
