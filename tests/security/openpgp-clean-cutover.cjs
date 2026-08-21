const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const packageManifest = JSON.parse(read('package.json'));
const pgpActions = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Pgp.php');
const vaultDocumentation = read('docs/openpgp-browser-vault.md');

for (const retired of [
	'scripts/openpgp-clean-cutover.cjs',
	'tests/playwright/openpgp-clean-cutover.cjs',
	'docs/openpgp-clean-cutover.md'
]) {
	assert(!fs.existsSync(path.join(root, retired)), `${retired} must stay retired.`);
}
assert(
	!Object.keys(packageManifest.scripts).some(name => name.includes('openpgp:cutover')),
	'Destructive OpenPGP cutover commands must not be exposed through package scripts.'
);
assert(
	!pgpActions.includes('discardLegacyPrivateKeyState')
		&& /DoPgpLegacyPrivateKeyPurge\(\)[\s\S]{0,300}FalseResponse/.test(pgpActions),
	'Browser-vault migration must not contain an implicit or callable legacy-key deletion path.'
);
assert(
	vaultDocumentation.includes("doesn't delete the")
		&& vaultDocumentation.includes('legacy purge endpoint remains disabled'),
	'The browser-vault contract must explicitly retain legacy recovery state.'
);

const retiredProvisioner = read('scripts/provision-miab-domain-gnupg.cjs');
assert(
	retiredProvisioner.includes('Server-side GnuPG provisioning is retired')
		&& retiredProvisioner.includes('process.exitCode = 2')
		&& !retiredProvisioner.includes('--generate-key'),
	'Legacy Mail-in-a-Box GnuPG provisioning must fail closed rather than reintroducing server-side private keys.'
);

console.log('OpenPGP legacy-retention contract checks passed');
