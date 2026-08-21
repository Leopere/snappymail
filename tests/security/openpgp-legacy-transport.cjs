const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');

(async () => {
	if (0 !== spawnSync('gpg', ['--version'], { stdio: 'ignore' }).status) {
		throw Error('gpg is required for the legacy transport interoperability test');
	}

	const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-legacy-transport-')),
		browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext({ ignoreHTTPSErrors: true });
		await context.route('https://legacy-transport.test/', route => route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html>'
		}));
		const page = await context.newPage();
		await page.goto('https://legacy-transport.test/');
		await page.addScriptTag({ path: path.join(root, 'vendors/openpgp-6/dist/openpgp.js') });
		const keys = await page.evaluate(async () => {
			const transport = await openpgp.generateKey({
					type: 'ecc',
					curve: 'curve25519',
					userIDs: [{ name: 'Transport', email: 'transport@example.invalid' }]
				}),
				legacy = await openpgp.generateKey({
					type: 'ecc',
					curve: 'curve25519',
					userIDs: [{ name: 'Legacy', email: 'legacy@example.invalid' }]
				}),
				transportKey = await openpgp.readKey({ armoredKey: transport.publicKey });
			return {
				transportPublicKey: transport.publicKey,
				transportPrivateKey: transport.privateKey,
				transportFingerprint: transportKey.getFingerprint(),
				legacyPrivateKey: legacy.privateKey
			};
		});
		const transportPath = path.join(temporaryHome, 'transport.asc'),
			legacyPath = path.join(temporaryHome, 'legacy.asc'),
			envelopePath = path.join(temporaryHome, 'envelope.asc');
		fs.writeFileSync(transportPath, keys.transportPublicKey, { mode: 0o600 });
		fs.writeFileSync(legacyPath, keys.legacyPrivateKey, { mode: 0o600 });
		execFileSync('gpg', ['--homedir', temporaryHome, '--batch', '--import', transportPath], {
			stdio: 'pipe'
		});
		execFileSync('gpg', [
			'--homedir', temporaryHome,
			'--batch', '--yes', '--trust-model', 'always', '--armor',
			'--output', envelopePath,
			'--encrypt', '--recipient', keys.transportFingerprint,
			legacyPath
		], { stdio: 'pipe' });
		const envelope = fs.readFileSync(envelopePath, 'utf8');
		assert(envelope.includes('-----BEGIN PGP MESSAGE-----'));
		const plaintext = await page.evaluate(async ({ armoredKey, armoredMessage }) => {
			const privateKey = await openpgp.readPrivateKey({ armoredKey }),
				result = await openpgp.decrypt({
					message: await openpgp.readMessage({ armoredMessage }),
					decryptionKeys: privateKey,
					format: 'utf8'
				});
			return result.data;
		}, {
			armoredKey: keys.transportPrivateKey,
			armoredMessage: envelope
		});
		assert.strictEqual(plaintext, keys.legacyPrivateKey);
		console.log('OpenPGP legacy transport interoperability check passed');
	} finally {
		await browser.close();
		fs.rmSync(temporaryHome, { recursive: true, force: true });
	}
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
