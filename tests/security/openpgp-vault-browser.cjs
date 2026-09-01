const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'dev/Storage/OpenPgpVault.js'), 'utf8')
	.replace('export const OpenPgpClientVault =', 'window.OpenPgpClientVault =');
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
	|| [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium'
	].find(candidate => fs.existsSync(candidate));

(async () => {
	const browser = await chromium.launch({
		headless: true,
		...(browserExecutable ? { executablePath: browserExecutable } : {})
	});
	try {
		const context = await browser.newContext({ ignoreHTTPSErrors: true });
		await context.route('https://vault.test/', route => route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html><title>OpenPGP vault test</title>'
		}));
		const page = await context.newPage();
		await page.goto('https://vault.test/');
		await page.evaluate(() => window.IDN = { toASCII: value => value });
		await page.addScriptTag({ content: source });
		await page.addScriptTag({ path: path.join(root, 'vendors/openpgp-6/dist/openpgp.js') });
		const result = await page.evaluate(async () => {
			const vault = window.OpenPgpClientVault,
				keyPassphrase = 'internal generated key passphrase',
				keyPair = await openpgp.generateKey({
					type: 'ecc',
					curve: 'curve25519',
					userIDs: [{ name: 'Vault Test', email: 'vault-test@example.invalid' }],
					passphrase: keyPassphrase
				}),
				recipientPair = await openpgp.generateKey({
					type: 'ecc',
					curve: 'curve25519',
					userIDs: [{ name: 'Recipient Test', email: 'recipient-test@example.invalid' }]
				}),
				payload = {
					version: 1,
					privateKeys: [{
						armor: keyPair.privateKey,
						passphrase: keyPassphrase,
						marker: 'browser-only-private-material'
					}]
				},
				created = await vault.create(
					'vault-test@example.invalid', payload, 'correct vault passphrase'
				),
				unlocked = await vault.unlockWithPassword(
					'vault-test@example.invalid', created.vault, 'correct vault passphrase'
				);
			let createLeavesDeviceUnchanged = false;
			try {
				await vault.unlockWithDevice('vault-test@example.invalid', created.vault);
			} catch (error) {
				createLeavesDeviceUnchanged = true;
			}
			await vault.rememberOnDevice('vault-test@example.invalid', created.vaultKey);
			const deviceUnlocked = await vault.unlockWithDevice(
				'vault-test@example.invalid', created.vault
			),
				rotated = await vault.changePassword(
					'vault-test@example.invalid', created.vault, created.vaultKey, 'new vault passphrase'
				),
				rotatedUnlocked = await vault.unlockWithPassword(
					'vault-test@example.invalid', rotated, 'new vault passphrase'
				),
				rotatedDeviceUnlocked = await vault.unlockWithDevice(
					'vault-test@example.invalid', rotated
				);
			let wrongPasswordRejected = false, oldPasswordRejected = false;
			try {
				await vault.unlockWithPassword('vault-test@example.invalid', created.vault, 'wrong vault passphrase');
			} catch (error) {
				wrongPasswordRejected = true;
			}
			try {
				await vault.unlockWithPassword('vault-test@example.invalid', rotated, 'correct vault passphrase');
			} catch (error) {
				oldPasswordRejected = true;
			}
				const restored = await openpgp.readPrivateKey({ armoredKey: rotatedUnlocked.payload.privateKeys[0].armor }),
						unlockedKey = await openpgp.decryptKey({
						privateKey: restored,
						passphrase: rotatedUnlocked.payload.privateKeys[0].passphrase
						}),
						recipientKey = await openpgp.readKey({ armoredKey: recipientPair.publicKey }),
						expectedRecipientKeyIds = await Promise.all([unlockedKey.toPublic(), recipientKey]
							.map(async key => (await key.getEncryptionKey()).getKeyID().toHex().toUpperCase())),
						encrypted = await openpgp.encrypt({
						message: await openpgp.createMessage({ text: 'browser vault OpenPGP round trip' }),
						encryptionKeys: [unlockedKey.toPublic(), recipientKey]
					}),
						packetRecipientKeyIds = (await openpgp.readMessage({ armoredMessage: encrypted }))
							.getEncryptionKeyIDs()
							.map(keyId => keyId.toHex().toUpperCase()),
						decrypted = await openpgp.decrypt({
					message: await openpgp.readMessage({ armoredMessage: encrypted }),
					decryptionKeys: unlockedKey,
					format: 'utf8'
				});
			return {
				serialized: JSON.stringify(created.vault),
				payloadCipherUnchanged: JSON.stringify(created.vault.payload) === JSON.stringify(rotated.payload),
				passwordWrapperChanged: JSON.stringify(created.vault.wrappers.password)
					!== JSON.stringify(rotated.wrappers.password),
				unlocked: unlocked.payload,
				createLeavesDeviceUnchanged,
				deviceUnlocked: deviceUnlocked.payload,
				rotatedUnlocked: rotatedUnlocked.payload,
				rotatedDeviceUnlocked: rotatedDeviceUnlocked.payload,
				wrongPasswordRejected,
					oldPasswordRejected,
					expectedRecipientKeyIds,
					packetRecipientKeyIds,
					plaintext: decrypted.data
			};
		});
		assert(!result.serialized.includes('browser-only-private-material'));
		assert(result.createLeavesDeviceUnchanged);
		assert(result.payloadCipherUnchanged, 'Password rewrapping must not modify payload ciphertext.');
		assert(result.passwordWrapperChanged, 'Password rewrapping must replace the password wrapper.');
		assert.deepStrictEqual(result.unlocked, result.rotatedUnlocked);
		assert.deepStrictEqual(result.unlocked, result.deviceUnlocked);
		assert.deepStrictEqual(result.unlocked, result.rotatedDeviceUnlocked);
		assert(result.wrongPasswordRejected);
		assert(result.oldPasswordRejected);
		assert.deepStrictEqual(
			result.packetRecipientKeyIds.sort(),
			result.expectedRecipientKeyIds.sort(),
			'OpenPGP output must contain a session-key packet for every encryption subkey.'
		);
		assert.strictEqual(result.plaintext, 'browser vault OpenPGP round trip');
		console.log('OpenPGP browser vault cryptography checks passed');
	} finally {
		await browser.close();
	}
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
