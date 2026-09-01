const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const vaultSource = fs.readFileSync(path.join(root, 'dev/Storage/OpenPgpVault.js'), 'utf8')
	.replace('export const OpenPgpClientVault =', 'window.OpenPgpClientVault =');
const migrationSource = fs.readFileSync(path.join(root, 'dev/Storage/OpenPgpLegacyMigration.js'), 'utf8')
	.replace("import { OpenPgpClientVault } from 'Storage/OpenPgpVault';", 'const OpenPgpClientVault = window.OpenPgpClientVault;')
	.replace('export const createLegacyTransport =', 'window.createLegacyTransport =')
	.replace('export const migrateLegacyExport =', 'window.migrateLegacyExport =');
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
	|| [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium'
	].find(candidate => fs.existsSync(candidate));

(async () => {
	if (0 !== spawnSync('gpg', ['--version'], { stdio: 'ignore' }).status) {
		throw Error('gpg is required for the legacy transport interoperability test');
	}

	const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-legacy-transport-')),
		browser = await chromium.launch({
			headless: true,
			...(browserExecutable ? { executablePath: browserExecutable } : {})
		});
	try {
		const context = await browser.newContext({ ignoreHTTPSErrors: true });
		await context.route('https://legacy-transport.test/', route => route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html>'
		}));
			const page = await context.newPage();
			await page.goto('https://legacy-transport.test/');
			await page.evaluate(() => window.IDN = { toASCII: value => value });
			await page.addScriptTag({ content: `(function () { ${vaultSource} })();` });
			await page.addScriptTag({ path: path.join(root, 'vendors/openpgp-6/dist/openpgp.js') });
			await page.addScriptTag({ content: `(function () { ${migrationSource} })();` });
			const keys = await page.evaluate(async () => {
				const transport = await window.createLegacyTransport('legacy@example.invalid'),
					historicalPassphrase = 'historical passphrase inside transport only',
					legacy = await openpgp.generateKey({
						type: 'ecc',
						curve: 'curve25519',
						userIDs: [{ name: 'Legacy', email: 'legacy@example.invalid' }],
						passphrase: historicalPassphrase
					}),
					transportKey = await openpgp.readKey({ armoredKey: transport.publicKey }),
					legacyKey = await openpgp.readKey({ armoredKey: legacy.publicKey }),
					oldCiphertext = await openpgp.encrypt({
						message: await openpgp.createMessage({ text: 'encrypted before browser-vault migration' }),
						encryptionKeys: legacyKey
					});
				return {
					transportPublicKey: transport.publicKey,
					transportPrivateKey: transport.privateKey,
					transportFingerprint: transportKey.getFingerprint(),
					legacyPrivateKey: legacy.privateKey,
					legacyPublicKey: legacy.publicKey,
					legacyFingerprint: legacyKey.getFingerprint().toUpperCase(),
					historicalPassphrase,
					oldCiphertext
				};
			});
			const transportPath = path.join(temporaryHome, 'transport.asc'),
				legacyPath = path.join(temporaryHome, 'legacy.asc'),
				payloadPath = path.join(temporaryHome, 'payload.json'),
				envelopePath = path.join(temporaryHome, 'envelope.asc');
			fs.writeFileSync(transportPath, keys.transportPublicKey, { mode: 0o600 });
			fs.writeFileSync(legacyPath, keys.legacyPrivateKey, { mode: 0o600 });
			fs.writeFileSync(payloadPath, JSON.stringify({
				version: 1,
				email: 'legacy@example.invalid',
				fingerprint: keys.legacyFingerprint,
				privateKey: keys.legacyPrivateKey,
				passphrase: keys.historicalPassphrase
			}), { mode: 0o600 });
			execFileSync('gpg', ['--homedir', temporaryHome, '--batch', '--import', transportPath], {
				stdio: 'pipe'
			});
			execFileSync('gpg', ['--homedir', temporaryHome, '--batch', '--import', legacyPath], {
				stdio: 'pipe'
			});
			const exportArgs = passphrase => [
				'--homedir', temporaryHome, '--batch', '--pinentry-mode', 'loopback',
				'--passphrase', passphrase, '--armor', '--export-secret-keys', keys.legacyFingerprint
			];
			const wrongExport = spawnSync('gpg', exportArgs(''), { encoding: 'utf8' });
			const correctExport = spawnSync('gpg', exportArgs(keys.historicalPassphrase), { encoding: 'utf8' });
			assert.notStrictEqual(wrongExport.status, 0, 'A wrong legacy passphrase must fail secret-key export.');
			assert(!wrongExport.stdout.includes('BEGIN PGP PRIVATE KEY'));
			assert.strictEqual(correctExport.status, 0, correctExport.stderr);
			assert(correctExport.stdout.includes('BEGIN PGP PRIVATE KEY'));

			execFileSync('gpg', [
				'--homedir', temporaryHome,
				'--batch', '--yes', '--trust-model', 'always', '--armor',
				'--output', envelopePath,
				'--encrypt', '--recipient', keys.transportFingerprint,
				payloadPath
			], { stdio: 'pipe' });
			const envelope = fs.readFileSync(envelopePath, 'utf8');
			assert(envelope.includes('-----BEGIN PGP MESSAGE-----'));
			assert(!envelope.includes(keys.historicalPassphrase));
			assert(!envelope.includes('BEGIN PGP PRIVATE KEY'));
			const migrated = await page.evaluate(async input => {
				const noLegacy = await window.migrateLegacyExport(input.email, {
						keys: [], detected: false, complete: true, activeFingerprint: '', publicKey: ''
					}, ''),
					migration = await window.migrateLegacyExport(input.email, {
						keys: [input.envelope],
						detected: true,
						complete: true,
						activeFingerprint: input.legacyFingerprint,
						publicKey: input.legacyPublicKey
					}, input.transportPrivateKey),
					entry = migration.payload.privateKeys[0],
					privateKey = await openpgp.decryptKey({
						privateKey: await openpgp.readPrivateKey({ armoredKey: entry.armor }),
						passphrase: entry.passphrase
					}),
					decrypted = await openpgp.decrypt({
						message: await openpgp.readMessage({ armoredMessage: input.oldCiphertext }),
						decryptionKeys: privateKey,
						format: 'utf8'
					});
				let incompleteRejected = false;
				try {
					await window.migrateLegacyExport(input.email, {
						keys: [], detected: true, complete: false, activeFingerprint: '', publicKey: ''
					}, input.transportPrivateKey);
				} catch (error) {
					incompleteRejected = true;
				}
				return {
					noLegacy,
					activeFingerprint: migration.payload.activeFingerprint,
					migratedFingerprint: privateKey.getFingerprint().toUpperCase(),
					newPassphrase: entry.passphrase,
					plaintext: decrypted.data,
					incompleteRejected
				};
			}, {
				email: 'legacy@example.invalid',
				envelope,
				transportPrivateKey: keys.transportPrivateKey,
				legacyFingerprint: keys.legacyFingerprint,
				legacyPublicKey: keys.legacyPublicKey,
				oldCiphertext: keys.oldCiphertext
			});
			assert.strictEqual(migrated.noLegacy, null);
			assert.strictEqual(migrated.activeFingerprint, keys.legacyFingerprint);
			assert.strictEqual(migrated.migratedFingerprint, keys.legacyFingerprint);
			assert.notStrictEqual(migrated.newPassphrase, keys.historicalPassphrase);
			assert.strictEqual(migrated.plaintext, 'encrypted before browser-vault migration');
			assert(migrated.incompleteRejected);
			console.log('OpenPGP legacy migration transport and old-message checks passed');
	} finally {
		await browser.close();
		fs.rmSync(temporaryHome, { recursive: true, force: true });
	}
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
