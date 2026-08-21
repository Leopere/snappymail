#!/usr/bin/env node

// Copyright © 2026 ColinKnapp.com. All rights reserved.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const account = {
	baseURL: process.env.SNAPPYMAIL_SINGLE_ACCOUNT_URL || 'https://mail.boompay.ca',
	email: (process.env.SNAPPYMAIL_SINGLE_ACCOUNT_EMAIL || '').trim().toLowerCase(),
	password: process.env.SNAPPYMAIL_SINGLE_ACCOUNT_PASSWORD || ''
};
if (!account.email || !account.password) {
	throw Error('Set SNAPPYMAIL_SINGLE_ACCOUNT_EMAIL and SNAPPYMAIL_SINGLE_ACCOUNT_PASSWORD in the process environment.');
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = path.join(root, 'tmp', 'openpgp-single-account', runId);
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const browserBundles = [
	'static/js/min/libs.min.js',
	'static/js/min/app.min.js',
	'static/js/min/openpgp.min.js'
];
const report = { runId, startedAt: new Date().toISOString(), status: 'running', checks: [] };
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

const record = async (label, action) => {
	const started = Date.now();
	try {
		const value = await action();
		report.checks.push({ label, status: 'passed', ms: Date.now() - started });
		return value;
	} catch (error) {
		report.checks.push({ label, status: 'failed', ms: Date.now() - started, error: error.message });
		throw error;
	}
};

const writeReport = (status, error = null) => {
	fs.mkdirSync(artifactRoot, { recursive: true });
	report.status = status;
	report.finishedAt = new Date().toISOString();
	report.error = error?.message || '';
	const file = path.join(artifactRoot, 'report.json');
	fs.writeFileSync(file, JSON.stringify(report, null, 2));
	return path.relative(root, file);
};

const requestAction = request => {
	try {
		return JSON.parse(request.postData() || '{}').Action || '';
	} catch (error) {
		return '';
	}
};

const zbase32 = bytes => {
	const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769';
	let output = '', value = 0, bits = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (5 <= bits) {
			bits -= 5;
			output += alphabet[(value >> bits) & 31];
		}
		value &= (1 << bits) - 1;
	}
	if (bits) {
		output += alphabet[(value << (5 - bits)) & 31];
	}
	return output;
};

const fetchWkd = async () => {
	const [local, domain] = account.email.split('@');
	if (!local || !domain) {
		throw Error('The single-account email address is invalid.');
	}
	const hash = zbase32(crypto.createHash('sha1').update(local, 'utf8').digest());
	const url = `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hash}?l=${encodeURIComponent(local)}`;
	const response = await fetch(url, { headers: { Accept: 'application/octet-stream' } });
	if (!response.ok) {
		throw Error(`The mailbox WKD object returned HTTP ${response.status}.`);
	}
	return [...new Uint8Array(await response.arrayBuffer())];
};

const verifyPublishedBundles = async () => {
	for (const bundle of browserBundles) {
		const local = path.join(root, 'snappymail/v/0.0.0', bundle);
		const response = await fetch(new URL(`/snappymail/v/${packageVersion}/${bundle}`, account.baseURL));
		assert(response.ok, `Published ${bundle} returned HTTP ${response.status}.`);
		assert.strictEqual(
			sha256(Buffer.from(await response.arrayBuffer())),
			sha256(fs.readFileSync(local)),
			`Published ${bundle} does not match this build.`
		);
	}
};

const waitForMailbox = async page => {
	await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true, null, { timeout: 90000 });
	await page.waitForFunction(() => document.querySelectorAll('.messageListItem').length
		|| document.body.innerText.includes('Empty list.'), null, { timeout: 60000 });
};

const login = async page => {
	await page.goto(account.baseURL, { waitUntil: 'commit', timeout: 30000 });
	await page.locator('input[name=Email]').waitFor({ state: 'visible', timeout: 45000 });
	await page.locator('input[name=Email]').fill(account.email);
	await page.locator('input[name=Password]').fill(account.password);
	await page.locator('.buttonLogin').click();
	await waitForMailbox(page);
	assert(!await page.locator('#V-PopupsIdentity').isVisible().catch(() => false),
		'The account requires identity onboarding; the acceptance test will not change account settings.');
};

const openCompose = async page => {
	await page.locator('#rl-left .buttonCompose:visible, #V-MailMessageList .buttonCompose:visible')
		.first().click({ timeout: 30000 });
	const compose = page.locator('#V-PopupsCompose');
	await compose.waitFor({ state: 'visible', timeout: 30000 });
	return compose;
};

const openFolder = async (page, name) => {
	const folder = page.locator('.b-folders-system a').filter({ hasText: name }).first();
	await folder.click({ timeout: 30000 });
	await waitForMailbox(page);
};

const openMessage = async (page, folder, subject) => {
	await openFolder(page, folder);
	for (let attempt = 0; attempt < 12; ++attempt) {
		const row = page.locator('.messageListItem').filter({ hasText: subject }).first();
		if (await row.isVisible().catch(() => false)) {
			await row.click({ force: true });
			await page.locator('#V-MailMessageView').waitFor({ state: 'visible', timeout: 30000 });
			return;
		}
		await page.waitForTimeout(5000);
		await page.reload({ waitUntil: 'commit', timeout: 30000 });
		await waitForMailbox(page);
		await openFolder(page, folder);
	}
	throw Error(`${folder} did not receive the encrypted self-test message.`);
};

const verifyOpenMessage = async (page, body, folder) => {
	await page.waitForFunction(expected => {
		const element = document.querySelector('#V-MailMessageView'),
			message = element && ko.dataFor(element)?.message?.(),
			signature = message?.pgpSigned?.();
		return !!message?.pgpDecrypted?.() && element.innerText.includes(expected)
			&& true === signature?.checked && true === signature?.success;
	}, body, { timeout: 90000 });
	const state = await page.locator('#V-MailMessageView').evaluate((element, expected) => {
		const message = ko.dataFor(element)?.message?.(),
			signature = message?.pgpSigned?.();
		return {
			decrypted: !!message?.pgpDecrypted?.(),
			bodyVisible: element.innerText.includes(expected),
			armorVisible: element.innerText.includes('-----BEGIN PGP MESSAGE-----'),
			signatureChecked: true === signature?.checked,
			signatureSuccess: true === signature?.success
		};
	}, body);
	assert(state.decrypted && state.bodyVisible && !state.armorVisible,
		`${folder} must show decrypted plaintext without OpenPGP armor.`);
	assert(state.signatureChecked && state.signatureSuccess,
		`${folder} must show a successfully verified signature.`);
	return state;
};

(async () => {
	let browser;
	try {
		await record('published-browser-bundles', verifyPublishedBundles);
		const wkdBinary = await record('mailbox-wkd-object', fetchWkd);
		browser = await chromium.launch({ headless: true });

		const sendContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
		const sendPage = await sendContext.newPage();
		const actions = [];
		sendPage.on('request', request => {
			const action = requestAction(request);
			action && actions.push(action);
		});
		await record('authenticated-vault-bootstrap', () => login(sendPage));

		const subject = `OpenPGP security self-test ${Date.now()}`;
		const body = `Signed and encrypted SnappyMail self-test ${Date.now()}`;
		const compose = await openCompose(sendPage);
		const preparation = await record('prepare-signed-encrypted-self-message', () => compose.evaluate(
			async (element, values) => {
				const view = ko.dataFor(element);
				view.to(values.email);
				view.cc('');
				view.bcc('');
				view.subject(values.subject);
				view.editor(editor => editor.setPlain(values.body));
				const params = await view.getMessageRequestParams('', false),
					privateModel = view.signOptions().find(option => 'OpenPGP' === option[0])?.[1];
				if (!privateModel || !params.encrypted) {
					throw Error(view.plaintextNotice() || 'The browser vault did not prepare encrypted mail.');
				}
				const privateKey = privateModel.key.isDecrypted()
					? privateModel.key
					: await openpgp.decryptKey({
						privateKey: privateModel.key,
						passphrase: privateModel.vaultPassphrase
					}),
					message = await openpgp.readMessage({ armoredMessage: params.encrypted }),
					local = await openpgp.decrypt({
						message,
						decryptionKeys: privateKey,
						verificationKeys: privateKey.toPublic(),
						format: 'utf8'
					});
				await Promise.all((local.signatures || []).map(signature => signature.verified));
				const selfHeader = params.autocrypt.find(header => header.addr.toLowerCase() === values.email),
					selfPublic = selfHeader && await openpgp.readKey({
						armoredKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n'
							+ selfHeader.keydata.trim() + '\n-----END PGP PUBLIC KEY BLOCK-----'
					}),
					wkd = await openpgp.readKey({ binaryKey: new Uint8Array(values.wkdBinary) }),
					wkdEmails = [...new Set(wkd.users.map(user => user.userID?.email?.toLowerCase()).filter(Boolean))];
				if (!selfPublic || wkd.isPrivate() || 1 !== wkd.users.length || 1 !== wkdEmails.length
					|| values.email !== wkdEmails[0]) {
					throw Error('The active browser key or WKD mailbox binding is invalid.');
				}
				await wkd.getSigningKey();
				await wkd.getEncryptionKey();
				return {
					encrypted: /^-----BEGIN PGP MESSAGE-----/.test(params.encrypted),
					signed: 0 < (local.signatures || []).length,
					encryptEnabled: true === view.doEncrypt(),
					signEnabled: true === view.doSign(),
					plaintextNotice: view.plaintextNotice(),
					packetCount: new Set(message.getEncryptionKeyIDs().map(id => id.toHex())).size,
					activeFingerprint: selfPublic.getFingerprint().toUpperCase(),
					wkdFingerprint: wkd.getFingerprint().toUpperCase()
				};
			}, { email: account.email, subject, body, wkdBinary }
		));
		assert(preparation.encrypted && preparation.signed && preparation.encryptEnabled && preparation.signEnabled,
			'The compose path must sign and encrypt the complete self-message.');
		assert.strictEqual(preparation.plaintextNotice, '', 'Encrypted compose must not show a plaintext fallback.');
		assert(1 <= preparation.packetCount, 'Ciphertext must include the mailbox encryption subkey packet.');
		assert.strictEqual(preparation.activeFingerprint, preparation.wkdFingerprint,
			'The active browser-vault key must match the mailbox WKD key.');

		await record('send-signed-encrypted-self-message', async () => {
			await compose.evaluate(element => ko.dataFor(element).sendCommand());
			const state = await sendPage.waitForFunction(() => {
				const element = document.querySelector('#V-PopupsCompose'),
					view = element && ko.dataFor(element);
				if (!view?.modalVisible?.()) return 'sent';
				if (view.plaintextFallbackPending || document.querySelector('#V-PopupsAsk')?.offsetParent) return 'plaintext';
				if (view.sendError?.()) return 'error';
				return '';
			}, null, { timeout: 90000 });
			const result = await state.jsonValue();
			assert.strictEqual(result, 'sent', result === 'plaintext'
				? 'Send attempted to fall back to plaintext; confirmation was not accepted.'
				: 'Encrypted self-send failed.');
		});
		await sendContext.close();

		assert(actions.includes('PgpClientVaultGet'), 'Login must read the browser vault record.');
		assert(!actions.includes('PgpClientVaultQuarantine') && !actions.includes('PgpClientVaultRestore'),
			'The accepted login must not quarantine or restore the key.');
		if (actions.includes('PgpLegacyProtectedKeyExport')) {
			assert(actions.includes('PgpClientVaultPut'), 'A legacy export must finish with one persisted browser vault.');
			assert(actions.indexOf('PgpLegacyProtectedKeyExport') < actions.indexOf('PgpClientVaultPut'),
				'Legacy export must precede browser-vault persistence.');
		}
		assert(actions.includes('PgpDiscoverPublicKey'), 'Compose must perform a fresh self WKD lookup.');
		assert(actions.includes('SendMessage'), 'The acceptance run must submit one encrypted self-message.');

		const receiveContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
		const receivePage = await receiveContext.newPage();
		await record('fresh-browser-password-unlock', () => login(receivePage));
		await record('sent-copy-decrypt-and-verify', async () => {
			await openMessage(receivePage, 'Sent', subject);
			report.sent = await verifyOpenMessage(receivePage, body, 'Sent');
		});
		await record('inbox-receive-decrypt-and-verify', async () => {
			await openMessage(receivePage, 'Inbox', subject);
			report.inbox = await verifyOpenMessage(receivePage, body, 'Inbox');
		});
		await receiveContext.close();

		report.fingerprint = preparation.activeFingerprint;
		report.vault = actions.includes('PgpLegacyProtectedKeyExport') ? 'migrated' : 'existing';
		report.actionCounts = Object.fromEntries([...new Set(actions)].map(action => [
			action, actions.filter(value => value === action).length
		]));
		const file = writeReport('passed');
		console.log(`Single-account OpenPGP acceptance passed; report: ${file}`);
	} catch (error) {
		const file = writeReport('failed', error);
		console.error(`Single-account OpenPGP acceptance failed; report: ${file}`);
		throw error;
	} finally {
		account.password = '';
		await browser?.close();
	}
})().catch(error => {
	console.error(error.message);
	process.exitCode = 1;
});
