const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const { CUTOVER_ACCOUNTS } = require(path.join(root, 'scripts/openpgp-clean-cutover.cjs'));
const runId = process.env.SNAPPYMAIL_OPENPGP_CUTOVER_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = path.resolve(process.env.SNAPPYMAIL_OPENPGP_CUTOVER_ARTIFACT_DIR
	|| path.join(root, 'tmp', 'openpgp-cutover', runId));
const report = { runId, startedAt: new Date().toISOString(), checks: [] };

const pageDiagnostics = new WeakMap();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const boundedPush = (items, value) => {
	if (items.length < 80) {
		items.push(value);
	}
};
const publicUrl = value => {
	try {
		const url = new URL(value);
		return url.origin + url.pathname;
	} catch (error) {
		return String(value).slice(0, 500);
	}
};
const requestAction = request => {
	try {
		return JSON.parse(request.postData() || '{}').Action || '';
	} catch (error) {
		return '';
	}
};
const attachPageDiagnostics = page => {
	const diagnostics = {
		console: [],
		pageErrors: [],
		requestStarts: [],
		responses: [],
		requestFailures: [],
		failedResponses: []
	};
	pageDiagnostics.set(page, diagnostics);
	page.on('console', message => {
		if (['error', 'warning'].includes(message.type())) {
			boundedPush(diagnostics.console, { type: message.type(), text: message.text().slice(0, 1000) });
		}
	});
	page.on('pageerror', error => boundedPush(diagnostics.pageErrors, error.message.slice(0, 1000)));
	page.on('request', request => {
		if (['fetch', 'script'].includes(request.resourceType())) {
			boundedPush(diagnostics.requestStarts, {
				type: request.resourceType(),
				url: publicUrl(request.url()),
				action: requestAction(request)
			});
		}
	});
	page.on('requestfailed', request => boundedPush(diagnostics.requestFailures, {
		url: publicUrl(request.url()),
		error: request.failure()?.errorText || ''
	}));
	page.on('response', response => {
		if (['fetch', 'script'].includes(response.request().resourceType())) {
			boundedPush(diagnostics.responses, {
				status: response.status(),
				type: response.request().resourceType(),
				url: publicUrl(response.url()),
				action: requestAction(response.request())
			});
		}
		if (400 <= response.status()) {
			boundedPush(diagnostics.failedResponses, { status: response.status(), url: publicUrl(response.url()) });
		}
	});
};

const relativePath = file => path.relative(process.cwd(), file) || file;
const runStep = async (label, action) => {
	const started = Date.now();
	try {
		const result = await action();
		report.checks.push({ label, status: 'passed', ms: Date.now() - started });
		return result;
	} catch (error) {
		report.checks.push({
			label,
			status: 'failed',
			ms: Date.now() - started,
			error: error?.message || String(error)
		});
		throw error;
	}
};
const writeReport = (status, error = null) => {
	const file = path.join(artifactRoot, 'report.json');
	try {
		fs.mkdirSync(artifactRoot, { recursive: true });
		fs.writeFileSync(file, JSON.stringify({
			...report,
			status,
			finishedAt: new Date().toISOString(),
			error: error ? (error.message || String(error)) : ''
		}, null, 2));
		return file;
	} catch (writeError) {
		console.error('Unable to write OpenPGP cutover report', writeError);
		return '';
	}
};
const capturePageFailure = async (label, page) => {
	if (!page || page.isClosed()) {
		return;
	}
	const filename = label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'page';
	const screenshot = path.join(artifactRoot, `${filename}-failure.png`);
	try {
		fs.mkdirSync(artifactRoot, { recursive: true });
		await page.screenshot({ path: screenshot, fullPage: true, timeout: 10000 });
	} catch (error) {
		// Browser state below is still useful when the screenshot cannot be captured.
	}
	const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
	report.diagnostics ||= [];
	report.diagnostics.push({
		label,
		url: page.url(),
		title: await page.title().catch(() => ''),
		body: body.slice(0, 2000),
		screenshot: fs.existsSync(screenshot) ? relativePath(screenshot) : '',
		browser: pageDiagnostics.get(page) || {}
	});
};

const envFile = process.env.SNAPPYMAIL_CUTOVER_ENV
	|| '/Users/aedev/.config/codex/snappymail-openpgp-cutover.env';
const readEnv = file => {
	const values = {};
	if (!fs.existsSync(file)) {
		return values;
	}
	for (const line of fs.readFileSync(file, 'utf8').split(/\n/)) {
		const match = line.match(/^export\s+([A-Z0-9_]+)='([^']*)'$/);
		if (match) {
			values[match[1]] = match[2];
		}
	}
	return values;
};
const fileSecrets = readEnv(envFile);
const secret = name => process.env[name] || fileSecrets[name] || '';
const accounts = CUTOVER_ACCOUNTS.map(account => ({
	...account,
	baseURL: 'nixc.us' === account.email.split('@').pop()
		? (process.env.SNAPPYMAIL_CUTOVER_NIXC_URL || 'https://mail.nixc.us')
		: (process.env.SNAPPYMAIL_CUTOVER_BOOMPAY_URL || 'https://mail.boompay.ca'),
	password: secret(account.passwordEnv)
}));
for (const account of accounts) {
	if (!account.password) {
		throw Error(`Missing ${account.passwordEnv}; set it in the environment or ${envFile}`);
	}
}
const accountByEmail = new Map(accounts.map(account => [account.email, account]));

const browserBundles = [
	'static/js/min/libs.min.js',
	'static/js/min/app.min.js',
	'static/js/min/openpgp.min.js'
];
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const fetchBundleHash = async (account, bundle) => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 20000);
	try {
		const host = new URL(account.baseURL).host;
		const url = new URL('/snappymail/v/0.0.0/' + bundle, account.baseURL).toString();
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) {
			throw Error(`Published ${bundle} request returned HTTP ${response.status}`);
		}
		return { host, bundle, sha256: sha256(Buffer.from(await response.arrayBuffer())) };
	} finally {
		clearTimeout(timeout);
	}
};
const assertPublishedBundles = async () => {
	report.bundles = {};
	const publicAccounts = [...new Map(accounts.map(account => [account.baseURL, account])).values()];
	for (const bundle of browserBundles) {
		const localBundle = path.join(root, 'snappymail/v/0.0.0', bundle);
		if (!fs.existsSync(localBundle)) {
			throw Error(`Missing local browser bundle: ${relativePath(localBundle)}. Run npm run build first.`);
		}
		const expected = sha256(fs.readFileSync(localBundle));
		const deployed = await Promise.all(publicAccounts.map(account => fetchBundleHash(account, bundle)));
		report.bundles[bundle] = { expected, deployed };
		for (const item of deployed) {
			assert.strictEqual(
				item.sha256,
				expected,
				`Published ${bundle} on ${item.host} does not match this build. Deploy before the clean-key acceptance test.`
			);
		}
	}
};

const waitForMailbox = async page => {
	const state = await page.waitForFunction(() => {
		if (document.querySelectorAll('.messageListItem').length || document.body.innerText.includes('Empty list.')) {
			return 'mailbox';
		}
		const login = document.querySelector('input[name=Email]');
		if (login && login.offsetParent && window.rl?.settings?.get?.('Auth') !== true) {
			return 'login';
		}
		return '';
	}, null, { timeout: 60000 });
	assert.strictEqual(await state.jsonValue(), 'mailbox', 'Authenticated session returned to sign-in before the mailbox was ready.');
};
const completeIdentityOnboarding = async page => {
	const modal = page.locator('#V-PopupsIdentity');
	if (!await modal.isVisible().catch(() => false)) {
		return;
	}
	await modal.locator('input[name=Name]').fill('SnappyMail OpenPGP cutover test');
	await modal.locator('button.buttonAddIdentity').click();
	await modal.waitFor({ state: 'hidden', timeout: 30000 });
};
const waitForAction = async (page, action, timeout = 30000) => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const diagnostics = pageDiagnostics.get(page) || {};
		if (diagnostics.requestStarts?.some(item => action === item.action)
			&& diagnostics.responses?.some(item => action === item.action && 400 > item.status)) {
			return;
		}
		await delay(100);
	}
	throw Error(`Timed out waiting for ${action}.`);
};
const login = async (page, account, expectFreshVault = false) => {
	await page.goto(account.baseURL, { waitUntil: 'commit', timeout: 30000 });
	await page.locator('input[name=Email]').waitFor({ state: 'visible', timeout: 45000 });
	await page.locator('input[name=Email]').fill(account.email);
	await page.locator('input[name=Password]').fill(account.password);
	await page.locator('.buttonLogin').click();
	await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true, null, { timeout: 90000 });
	await waitForMailbox(page);
	await completeIdentityOnboarding(page);
	if (expectFreshVault) {
		await waitForAction(page, 'PgpClientVaultGet');
		await waitForAction(page, 'PgpClientVaultPut');
		assert(!await page.locator('#V-PopupsOpenPgpGenerate:visible').count(), 'Fresh vault creation must not prompt the user.');
	}
};
const openCompose = async page => {
	const button = page.locator('#rl-left .buttonCompose:visible, #V-MailMessageList .buttonCompose:visible').first();
	await button.click({ timeout: 30000 });
	const compose = page.locator('#V-PopupsCompose');
	await compose.waitFor({ state: 'visible', timeout: 30000 });
	return compose;
};
const closeCompose = async compose => {
	await compose.evaluate(element => ko.dataFor(element).close());
	await compose.waitFor({ state: 'hidden', timeout: 30000 });
};
const openFolder = async (page, folderName) => {
	const folder = page.locator('.b-folders-system a').filter({ hasText: folderName }).first();
	await folder.click({ timeout: 30000 });
	await page.waitForFunction(expected => {
		const selected = document.querySelector('.b-folders-system a.selected');
		return selected?.textContent.trim() === expected;
	}, folderName, { timeout: 30000 });
	await waitForMailbox(page);
};

const prepareRecipientPackets = async (compose, source, recipients, label) => {
	const prepared = await compose.evaluate(async (element, values) => {
		const view = ko.dataFor(element);
		view.to(values.recipients.join(', '));
		view.cc('');
		view.bcc('');
		view.subject('OpenPGP clean-cutover packet contract');
		view.editor(editor => editor.setPlain('Packet validation only; this message is never sent.'));
		const params = await view.getMessageRequestParams('', false);
		const packetRecipientKeyIds = (await openpgp.readMessage({ armoredMessage: params.encrypted }))
			.getEncryptionKeyIDs()
			.map(keyId => keyId.toHex().toUpperCase())
			.sort();
		const expected = await Promise.all(params.autocrypt.map(async header => {
			const armoredKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n'
				+ header.keydata.trim()
				+ '\n-----END PGP PUBLIC KEY BLOCK-----';
			const key = await openpgp.readKey({ armoredKey });
			return {
				email: header.addr.toLowerCase(),
				keyId: (await key.getEncryptionKey()).getKeyID().toHex().toUpperCase()
			};
		}));
		return { packetRecipientKeyIds, expected };
	}, { recipients: recipients.map(account => account.email) });
	const expectedIds = prepared.expected.map(item => item.keyId).sort();
	assert.deepStrictEqual(
		prepared.packetRecipientKeyIds,
		expectedIds,
		`${label}: ciphertext must contain every sender and recipient encryption packet.`
	);
	for (const account of [source].concat(recipients)) {
		assert(
			prepared.expected.some(item => item.email === account.email),
			`${label}: missing WKD encryption key for ${account.email}.`
		);
	}
	report.keyIdsByEmail ||= {};
	for (const item of prepared.expected) {
		if (accountByEmail.has(item.email)) {
			const previous = report.keyIdsByEmail[item.email];
			assert(!previous || previous === item.keyId, `${item.email} changed encryption subkeys during the cutover test.`);
			report.keyIdsByEmail[item.email] = item.keyId;
		}
	}
	report.messages ||= {};
	report.messages[label] = { ...(report.messages[label] || {}), packetRecipientKeyIds: prepared.packetRecipientKeyIds };
};
const sendEncryptedMessage = async (page, recipients, label) => {
	const subject = `OpenPGP clean cutover ${label} ${Date.now()}`;
	const body = `OpenPGP clean cutover ${label} body ${Date.now()}`;
	const compose = await openCompose(page);
	await compose.evaluate((element, values) => {
		const view = ko.dataFor(element);
		view.to(values.recipients.join(', '));
		view.cc('');
		view.bcc('');
		view.subject(values.subject);
		view.editor(editor => editor.setPlain(values.body));
	}, { recipients: recipients.map(account => account.email), subject, body });
	await compose.evaluate(element => ko.dataFor(element).sendCommand());
	await page.waitForFunction(() => {
		const view = ko.dataFor(document.querySelector('#V-PopupsCompose'));
		return !view?.modalVisible?.() || !!view?.sendError?.();
	}, null, { timeout: 90000 });
	const sendError = await compose.evaluate(element => ko.dataFor(element)?.sendErrorDesc?.() || '');
	assert(!sendError, `${label}: encrypted send failed: ${sendError}`);
	return { subject, body };
};

const verifyMessage = async (browser, account, message, label, folder = 'Inbox') => {
	const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
	let page = null;
	try {
		page = await context.newPage();
		attachPageDiagnostics(page);
		await login(page, account);
		if ('Sent' === folder) {
			await openFolder(page, 'Sent');
		}
		await page.getByText(message.subject, { exact: true }).first().click({ force: true, timeout: 90000 });
		await page.waitForFunction(body => {
			const element = document.querySelector('#V-MailMessageView');
			const message = ko.dataFor(element)?.message?.();
			const signature = message?.pgpSigned?.();
			return !!message?.pgpDecrypted?.()
				&& element?.innerText.includes(body)
				&& true === signature?.checked
				&& true === signature?.success;
		}, message.body, { timeout: 90000 });
		const state = await page.locator('#V-MailMessageView').evaluate((element, body) => {
			const message = ko.dataFor(element)?.message?.();
			const signature = message?.pgpSigned?.();
			return {
				decrypted: !!message?.pgpDecrypted?.(),
				bodyVisible: element.innerText.includes(body),
				armorVisible: element.innerText.includes('-----BEGIN PGP MESSAGE-----'),
				signature: {
					checked: true === signature?.checked,
					success: true === signature?.success,
					error: signature?.error || ''
				}
			};
		}, message.body);
		assert(state.decrypted && state.bodyVisible && !state.armorVisible, `${label}: ${folder} copy did not decrypt to plaintext.`);
		assert(state.signature.checked && state.signature.success, `${label}: ${folder} copy did not verify the signature.`);
		report.messages ||= {};
		report.messages[label] ||= {};
		report.messages[label][`${folder.toLowerCase()}:${account.email}`] = state;
	} catch (error) {
		await capturePageFailure(`${label}:${folder}:${account.email}`, page);
		throw error;
	} finally {
		await context.close();
	}
};

const runMessage = async (browser, source, recipients, label) => {
	const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
	let page = null, message = null;
	try {
		page = await context.newPage();
		attachPageDiagnostics(page);
		await runStep(`${label}: sender-login`, () => login(page, source));
		const compose = await runStep(`${label}: packet-build`, () => openCompose(page));
		await runStep(`${label}: recipient-packets`, () => prepareRecipientPackets(compose, source, recipients, label));
		await runStep(`${label}: close-packet-compose`, () => closeCompose(compose));
		message = await runStep(`${label}: encrypted-send`, () => sendEncryptedMessage(page, recipients, label));
	} catch (error) {
		await capturePageFailure(`${label}:sender`, page);
		throw error;
	} finally {
		await context.close();
	}
	await runStep(`${label}: sender-sent-copy-decrypt-and-verify`, () => verifyMessage(browser, source, message, label, 'Sent'));
	for (const recipient of recipients) {
		await runStep(`${label}: ${recipient.email}-inbox-decrypt-and-verify`, () => verifyMessage(browser, recipient, message, label));
	}
};

const verifyMixedRecipientPlaintextPolicy = async (browser, source, knownRecipient) => {
	const label = 'mixed-boompay-and-gmail';
	const gmail = 'knappcolin04@gmail.com';
	const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
	let page = null;
	try {
		page = await context.newPage();
		attachPageDiagnostics(page);
		await login(page, source);
		const compose = await openCompose(page);
		const result = await compose.evaluate(async (element, values) => {
			const view = ko.dataFor(element);
			view.to(values.known);
			view.cc(values.gmail);
			view.bcc('');
			view.subject('OpenPGP mixed-recipient plaintext policy');
			view.editor(editor => editor.setPlain('This plaintext policy message is constructed locally and never sent.'));
			const params = await view.getMessageRequestParams('', false);
			return {
				encrypted: !!params.encrypted,
				signed: !!params.signed,
				autocrypt: params.autocrypt || [],
				plain: params.plain || '',
				to: params.to,
				cc: params.cc,
				notice: view.plaintextNotice()
			};
		}, { known: knownRecipient.email, gmail });
		assert(!result.encrypted && !result.signed && !result.autocrypt.length,
			'A mixed-recipient message must remain plaintext instead of partially encrypting to known recipients.');
		assert(result.plain.includes('This plaintext policy message is constructed locally and never sent.'),
			'The mixed-recipient plaintext fallback must preserve the message body.');
		assert(result.to.includes(knownRecipient.email) && result.cc.includes(gmail),
			'The mixed-recipient plaintext fallback must retain every recipient.');
		assert.match(result.notice, /sent in plaintext/i,
			'The mixed-recipient plaintext fallback must warn the user without blocking delivery.');
		report.mixedRecipient = { source: source.email, knownRecipient: knownRecipient.email, gmail, ...result };
	} catch (error) {
		await capturePageFailure(`${label}:sender`, page);
		throw error;
	} finally {
		await context.close();
	}
};

(async () => {
	let browser = null;
	try {
		await runStep('published-browser-bundles', assertPublishedBundles);
		browser = await runStep('launch-browser', () => chromium.launch({ headless: true }));
		for (const account of accounts) {
			await runStep(`fresh-login-vault-bootstrap:${account.email}`, async () => {
				const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
				let page = null;
				try {
					page = await context.newPage();
					attachPageDiagnostics(page);
					await login(page, account, true);
					report.bootstrap ||= {};
					report.bootstrap[account.email] = {
						vaultGet: true,
						vaultPut: true,
						requests: (pageDiagnostics.get(page)?.requestStarts || [])
							.filter(item => ['PgpClientVaultGet', 'PgpClientVaultPut'].includes(item.action))
					};
				} catch (error) {
					await capturePageFailure(`fresh-bootstrap:${account.email}`, page);
					throw error;
				} finally {
					await context.close();
				}
			});
		}

		for (let index = 0; index < accounts.length; index += 1) {
			const source = accounts[index], target = accounts[(index + 1) % accounts.length];
			await runMessage(browser, source, [target], `single-${source.email}-to-${target.email}`);
		}
		await runMessage(browser, accounts[4], accounts.slice(0, 4), 'multi-colin-nixc-to-all-boompay');
		await runStep('mixed-boompay-and-gmail-prepares-plaintext', () => verifyMixedRecipientPlaintextPolicy(browser, accounts[3], accounts[0]));

		assert.deepStrictEqual(
			Object.keys(report.keyIdsByEmail || {}).sort(),
			accounts.map(account => account.email).sort(),
			'Every named mailbox must publish an encryption subkey through fresh WKD discovery.'
		);
		assert.strictEqual(
			new Set(Object.values(report.keyIdsByEmail)).size,
			accounts.length,
			'Each named mailbox must receive a distinct fresh encryption key; shared keys are forbidden.'
		);
		const reportFile = writeReport('passed');
		console.log('OpenPGP clean-cutover contract passed: five fresh vaults, single and multi-recipient delivery, Sent copies, and Gmail mixed-recipient plaintext fallback verified.');
		reportFile && console.log('OpenPGP clean-cutover report: ' + relativePath(reportFile));
	} catch (error) {
		const reportFile = writeReport('failed', error);
		reportFile && console.error('OpenPGP clean-cutover report: ' + relativePath(reportFile));
		throw error;
	} finally {
		await browser?.close();
	}
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
