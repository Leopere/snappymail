const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const runId = process.env.SNAPPYMAIL_OPENPGP_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = path.resolve(process.env.SNAPPYMAIL_OPENPGP_ARTIFACT_DIR
	|| path.join(root, 'tmp', 'openpgp-contract', runId));
const report = {
	runId,
	startedAt: new Date().toISOString(),
	checks: []
};

const pageDiagnostics = new WeakMap();
const boundedPush = (items, value) => {
	if (items.length < 20) {
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
const isMessageRequest = request => decodeURIComponent(request.url()).includes('/Message/');
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
		console.error('Unable to write OpenPGP contract report', writeError);
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
		// The state details below are still useful when the page cannot screenshot.
	}
	const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
	const crypto = await page.locator('#V-MailMessageView').evaluate(element => {
		const view = ko.dataFor(element),
			message = view?.message?.(),
			encrypted = message?.pgpEncrypted?.(),
			signature = message?.pgpSigned?.();
		return {
			encrypted: !!encrypted,
			decrypted: !!message?.pgpDecrypted?.(),
			decryptError: 'string' === typeof encrypted?.error ? encrypted.error : '',
			signature: signature ? {
				checked: true === signature.checked,
				success: true === signature.success,
				checking: true === signature.checking,
				error: signature.error || ''
			} : null,
			forwardEnabled: !!view?.forwardCommand?.canExecute?.()
		};
	}).catch(() => null);
	report.diagnostics ||= [];
	report.diagnostics.push({
		label,
		url: page.url(),
		title: await page.title().catch(() => ''),
		messageListItems: await page.locator('.messageListItem').count().catch(() => 0),
		body: body.slice(0, 2000),
		screenshot: fs.existsSync(screenshot) ? relativePath(screenshot) : '',
		crypto,
		browser: pageDiagnostics.get(page) || {}
	});
};

const envFile = process.env.SNAPPYMAIL_AUDIT_ENV
	|| '/Users/aedev/.config/codex/snappymail-miab-audit-users.env';

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
const sender = {
	baseURL: process.env.SNAPPYMAIL_AUDIT_NIXC_URL || 'https://mail.nixc.us',
	email: secret('SNAPPYMAIL_AUDIT_NIXC_A_EMAIL'),
	password: secret('SNAPPYMAIL_AUDIT_NIXC_A_PASSWORD')
};
const recipient = {
	baseURL: process.env.SNAPPYMAIL_AUDIT_BOOMPAY_URL || 'https://mail.boompay.ca',
	email: secret('SNAPPYMAIL_AUDIT_BOOMPAY_B_EMAIL'),
	password: secret('SNAPPYMAIL_AUDIT_BOOMPAY_B_PASSWORD')
};
const namedWkdRecipients = [
	'mike.lefler@boompay.ca',
	'mike.mcarthur@boompay.ca',
	'kevin.haywood@boompay.ca',
	'colin@nixc.us',
	'colin.knapp@boompay.ca'
];
const protonWkdRecipient = 'contact@proton.me';

for (const [name, value] of Object.entries({
	'sender email': sender.email,
	'sender password': sender.password,
	'recipient email': recipient.email,
	'recipient password': recipient.password
})) {
	if (!value) {
		throw Error(`Missing ${name}; set it in the environment or ${envFile}`);
	}
}

const browserBundles = [
	'static/js/min/libs.min.js',
	'static/js/min/app.min.js',
	'static/js/min/openpgp.min.js'
];
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const fetchBundleHash = async (account, bundle) => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 20000);
	try {
		const host = new URL(account.baseURL).host;
		const url = new URL(`/snappymail/v/${packageVersion}/${bundle}`, account.baseURL).toString();
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) {
			throw Error(`Published ${bundle} request returned HTTP ${response.status}`);
		}
		return {
			host,
			bundle,
			sha256: sha256(Buffer.from(await response.arrayBuffer()))
		};
	} catch (error) {
		throw Error(`Unable to fetch published ${bundle} from ${account.baseURL}: ${error?.message || String(error)}`);
	} finally {
		clearTimeout(timeout);
	}
};
const assertPublishedBundles = async () => {
	report.bundles = {};
	for (const bundle of browserBundles) {
		const localBundle = path.join(root, 'snappymail/v/0.0.0', bundle);
		if (!fs.existsSync(localBundle)) {
			throw Error(`Missing local browser bundle: ${relativePath(localBundle)}. Run npm run build first.`);
		}
		const expected = sha256(fs.readFileSync(localBundle));
		const deployed = await Promise.all([sender, recipient].map(account => fetchBundleHash(account, bundle)));
		report.bundles[bundle] = { expected, deployed };
		for (const item of deployed) {
			assert.strictEqual(
				item.sha256,
				expected,
				`Published ${bundle} on ${item.host} does not match this build. Deploy the complete browser bundle set before running the live OpenPGP gate.`
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
	assert.strictEqual(
		await state.jsonValue(),
		'mailbox',
		'Authenticated session returned to the sign-in screen before the mailbox was ready.'
	);
};

const completeIdentityOnboarding = async page => {
	const modal = page.locator('#V-PopupsIdentity');
	if (!await modal.isVisible().catch(() => false)) {
		return;
	}
	await modal.locator('input[name=Name]').fill('SnappyMail OpenPGP QA');
	await modal.locator('button.buttonAddIdentity').click();
	await modal.waitFor({ state: 'hidden', timeout: 30000 });
};

const login = async (page, account) => {
	await page.goto(account.baseURL, { waitUntil: 'commit', timeout: 30000 });
	await page.locator('input[name=Email]').waitFor({ state: 'visible', timeout: 45000 });
	await page.locator('input[name=Email]').fill(account.email);
	await page.locator('input[name=Password]').fill(account.password);
	await page.locator('.buttonLogin').click();
	await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true, null, { timeout: 90000 });
	await waitForMailbox(page);
	await completeIdentityOnboarding(page);
};

const openCompose = async page => {
	const button = page.locator('#rl-left .buttonCompose:visible, #V-MailMessageList .buttonCompose:visible').first();
	await button.click({ timeout: 30000 });
	const compose = page.locator('#V-PopupsCompose');
	await compose.waitFor({ state: 'visible', timeout: 30000 });
	return compose;
};

const closeCompose = async (page, compose) => {
	await compose.evaluate(element => ko.dataFor(element).close());
	await compose.waitFor({ state: 'hidden', timeout: 30000 });
};

const verifyZeroTouchProtonWkd = async page => {
	const compose = await openCompose(page);
	try {
		const prepared = await compose.evaluate(async (element, target) => {
			const view = ko.dataFor(element);
			view.to(target);
			view.subject('OpenPGP zero-touch Proton WKD check');
			view.editor(editor => editor.setPlain('No message is sent by this compatibility check.'));
			await view.initEncrypt();
			const params = await view.getMessageRequestParams('', false);
			const keyIds = params.encrypted
				? (await openpgp.readMessage({ armoredMessage: params.encrypted }))
					.getEncryptionKeyIDs().map(keyId => keyId.toHex().toUpperCase())
				: [];
			return {
				automatic: true === view.automaticOpenPgpPolicy,
				encrypt: true === view.doEncrypt(),
				sign: true === view.doSign(),
				notice: view.plaintextNotice(),
				encrypted: params.encrypted || '',
				keyIds
			};
		}, protonWkdRecipient);

		assert(prepared.automatic, 'A standard Proton WKD recipient must enable automatic OpenPGP without setup.');
		assert(prepared.encrypt && prepared.sign, 'The zero-touch Proton path must encrypt and sign by default.');
		assert.strictEqual(prepared.notice, '', 'The zero-touch Proton path must not show a plaintext fallback warning.');
		assert.match(prepared.encrypted, /^-----BEGIN PGP MESSAGE-----/,
			'The zero-touch Proton path must prepare OpenPGP ciphertext.');
		assert(2 <= new Set(prepared.keyIds).size,
			'Proton ciphertext must include distinct recipient and encrypt-to-self key packets.');
		report.protonWkd = {
			recipient: protonWkdRecipient,
			automatic: prepared.automatic,
			encrypted: true,
			signed: prepared.sign,
			recipientPacketCount: new Set(prepared.keyIds).size
		};
	} finally {
		await closeCompose(page, compose);
	}
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

const sendEncryptedQaMessage = async (page, target, label) => {
	const subject = `OpenPGP ${label} ${Date.now()}`;
	const body = `OpenPGP ${label} body ${Date.now()}`;
	const compose = await openCompose(page);
	await compose.evaluate((element, values) => {
		const view = ko.dataFor(element);
		view.to(values.target);
		view.subject(values.subject);
		view.editor(editor => editor.setPlain(values.body));
	}, { target, subject, body });
	await compose.evaluate(element => ko.dataFor(element).sendCommand());
	await page.waitForFunction(() => {
		const element = document.querySelector('#V-PopupsCompose');
		const view = element && ko.dataFor(element);
		return !view?.modalVisible?.() || view.sendError?.();
	}, null, { timeout: 90000 });
	const sendError = await compose.evaluate(element => ko.dataFor(element)?.sendErrorDesc?.() || '');
	assert(!sendError, `QA encrypted send failed: ${sendError}`);
	return { subject, body };
};

const verifyForwardUsesPlaintext = async (browser, account, message, label) => {
	const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
	let page = null;
	try {
		page = await context.newPage();
		attachPageDiagnostics(page);
		await login(page, account);
		await page.getByText(message.subject, { exact: true }).first().click({ force: true, timeout: 90000 });
		await page.waitForFunction(body => {
			const element = document.querySelector('#V-MailMessageView');
			const view = element && ko.dataFor(element),
				item = view?.message?.(),
				signature = item?.pgpSigned?.();
			return !!item?.pgpDecrypted?.()
				&& element.innerText.includes(body)
				&& true === signature?.checked
				&& true === signature?.success
				&& !!view?.forwardCommand?.canExecute?.();
		}, message.body, { timeout: 90000 });
		const messageView = page.locator('#V-MailMessageView');
		const delivery = await messageView.evaluate((element, body) => {
			const view = ko.dataFor(element),
				item = view?.message?.(),
				signature = item?.pgpSigned?.();
			return {
				decrypted: !!item?.pgpDecrypted?.(),
				bodyVisible: element.innerText.includes(body),
				signature: {
					checked: true === signature?.checked,
					success: true === signature?.success,
					error: signature?.error || ''
				},
				forwardEnabled: !!view?.forwardCommand?.canExecute?.()
			};
		}, message.body);
		report.directions ||= {};
		report.directions[label] = { ...report.directions[label], delivery };
		await messageView.locator('#more-view-dropdown-id').click({ timeout: 30000 });
		const forward = messageView.locator('menu.dropdown-menu [data-bind="command: forwardCommand"]');
		await forward.waitFor({ state: 'visible', timeout: 30000 });
		await forward.click({ timeout: 30000 });
		const compose = page.locator('#V-PopupsCompose');
		await compose.waitFor({ state: 'visible', timeout: 30000 });
		const forwarded = await compose.evaluate(element => ko.dataFor(element).oEditor.getData());
		assert(forwarded.includes(message.body), 'Forward must contain the visible decrypted body.');
		assert(!forwarded.includes('-----BEGIN PGP MESSAGE-----'), 'Forward must not copy original PGP armor.');
	} catch (error) {
		await capturePageFailure(`${label}: recipient-forward`, page);
		throw error;
	} finally {
		await context.close();
	}
};

const verifySentCopy = async (browser, account, message, label, retryVaultRead = false) => {
	const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
	let page = null, vaultReads = 0, vaultWrites = 0, pgpFetchesBeforeMessage = 0, fullMessageRequests = 0,
		holdFullMessage = false, releaseMessageResponse, resolveMessageRequest;
	const messageResponseGate = new Promise(resolve => releaseMessageResponse = resolve),
		messageRequestStarted = new Promise(resolve => resolveMessageRequest = resolve),
		vaultRoute = async route => {
			const request = route.request(),
				action = requestAction(request);
			if (holdFullMessage && isMessageRequest(request)) {
				++fullMessageRequests;
				resolveMessageRequest();
				await messageResponseGate;
				return route.continue();
			}
			holdFullMessage && 'PgpFetchEncryptedMessage' === action && ++pgpFetchesBeforeMessage;
		if ('PgpClientVaultGet' === action) {
			++vaultReads;
			if (1 === vaultReads) {
				return route.abort('failed');
			}
		}
		'PgpClientVaultPut' === action && ++vaultWrites;
		return route.continue();
	};
	try {
		page = await context.newPage();
		attachPageDiagnostics(page);
		retryVaultRead && await page.route('**/*', vaultRoute);
		await login(page, account);
		await openFolder(page, 'Sent');
		holdFullMessage = retryVaultRead;
		await page.getByText(message.subject, { exact: true }).first().click({ force: true, timeout: 90000 });
		if (retryVaultRead) {
			await Promise.race([
				messageRequestStarted,
				new Promise((resolve, reject) => setTimeout(() => reject(Error('Full Message response did not start.')), 15000))
			]);
			await page.waitForTimeout(750);
			assert.strictEqual(pgpFetchesBeforeMessage, 0,
				'Decrypt must wait for the full Message body, not fetch/decrypt from list metadata.');
			releaseMessageResponse();
		}
		await page.waitForFunction(body => {
			const element = document.querySelector('#V-MailMessageView');
			const item = ko.dataFor(element)?.message?.();
			const signature = item?.pgpSigned?.();
			return !!item?.pgpDecrypted?.()
				&& element?.innerText.includes(body)
				&& true === signature?.checked
				&& true === signature?.success;
		}, message.body, { timeout: 90000 });
		const sentDelivery = await page.locator('#V-MailMessageView').evaluate((element, body) => {
			const item = ko.dataFor(element)?.message?.();
			const signature = item?.pgpSigned?.();
			return {
				decrypted: !!item?.pgpDecrypted?.(),
				bodyVisible: element.innerText.includes(body),
				armorVisible: element.innerText.includes('-----BEGIN PGP MESSAGE-----'),
				signature: {
					checked: true === signature?.checked,
					success: true === signature?.success,
					error: signature?.error || ''
				}
			};
		}, message.body);
		assert(sentDelivery.decrypted && sentDelivery.bodyVisible && !sentDelivery.armorVisible,
			'Sent copy must decrypt to plaintext instead of retaining PGP armor.');
		assert(sentDelivery.signature.checked && sentDelivery.signature.success,
			'Sent copy signature must be verified by the sender browser.');
		const staleBodyResponseGuard = await page.locator('#V-MailMessageView').evaluate((element, body) => {
			const item = ko.dataFor(element)?.message?.(),
				encrypted = item?.pgpEncrypted?.(),
				stale = {
					'@Object': 'Object/Message',
					folder: item.folder,
					uid: item.uid,
					hash: item.hash,
					plain: '-----BEGIN PGP MESSAGE-----\nsynthetic stale response\n-----END PGP MESSAGE-----',
					html: '',
					pgpEncrypted: encrypted && { partId: encrypted.partId, keyIds: encrypted.keyIds || [] },
					pgpSigned: null
				};
			item.revivePropertiesFromJson(stale);
			const signature = item.pgpSigned?.();
			return {
				decrypted: !!item.pgpDecrypted?.(),
				bodyVisible: item.plain?.().includes(body),
				armorVisible: item.plain?.().includes('-----BEGIN PGP MESSAGE-----'),
				signature: {
					checked: true === signature?.checked,
					success: true === signature?.success
				}
			};
		}, message.body);
		assert(staleBodyResponseGuard.decrypted && staleBodyResponseGuard.bodyVisible
			&& !staleBodyResponseGuard.armorVisible,
			'A late armored Message response must not replace the decoded body.');
		assert(staleBodyResponseGuard.signature.checked && staleBodyResponseGuard.signature.success,
			'A late armored Message response must not erase the verified signature state.');
		if (retryVaultRead) {
			assert.strictEqual(vaultReads, 2,
				'One failed browser-vault read must be retried once without a page refresh.');
			assert.strictEqual(vaultWrites, 0,
				'A failed browser-vault read must not create or replace the server vault.');
		}
		report.directions ||= {};
		report.directions[label] = {
			...report.directions[label],
			sentDelivery,
			staleBodyResponseGuard,
			...(retryVaultRead ? {
				vaultBootstrapRetry: { reads: vaultReads, writes: vaultWrites },
				fullMessageGate: { requests: fullMessageRequests, pgpFetchesBeforeMessage }
			} : {})
		};
	} catch (error) {
		await capturePageFailure(`${label}: sender-sent-copy`, page);
		throw error;
	} finally {
		releaseMessageResponse?.();
		page && retryVaultRead && await page.unroute('**/*', vaultRoute).catch(() => {});
		await context.close();
	}
};

const verifyRecipientPolicyAndPacketBuild = async (compose, source, target, label, checkMixedRecipientPolicy) => {
	const prepared = await runStep(`${label}: recipient-key-policy-and-packet-build`, () => compose.evaluate(async (element, values) => {
		const view = ko.dataFor(element);
		view.to(values.target);
		view.cc('');
		view.bcc('');
		view.subject('OpenPGP packet contract QA');
		view.editor(editor => editor.setPlain('This message is constructed locally and never sent.'));

		const params = await view.getMessageRequestParams('', false);
		const privateKey = view.signOptions().find(option => 'OpenPGP' === option[0])?.[1];
		if (!privateKey) {
			throw Error('The sender browser vault did not provide an OpenPGP private key for local ciphertext verification.');
		}
		const decryptionKey = privateKey.key.isDecrypted()
			? privateKey.key
			: await openpgp.decryptKey({ privateKey: privateKey.key, passphrase: privateKey.vaultPassphrase });
		const localDecrypt = await openpgp.decrypt({
			message: await openpgp.readMessage({ armoredMessage: params.encrypted }),
			decryptionKeys: decryptionKey,
			format: 'utf8'
		});
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
				email: header.addr,
				keyId: (await key.getEncryptionKey()).getKeyID().toHex().toUpperCase()
			};
		}));

		let mixed = null;
		let staleCache = null;
		let encryptionFailure = null;
		const plaintextSummary = params => ({
			encrypted: !!params.encrypted,
			signed: !!params.signed,
			plain: params.plain || '',
			autocrypt: params.autocrypt || [],
			to: params.to,
			cc: params.cc,
			notice: view.plaintextNotice()
		});
		if (values.checkMixedRecipientPolicy) {
			view.to(values.target);
			view.cc(values.unencryptableRecipient);
			mixed = plaintextSummary(await view.getMessageRequestParams('', false));

			// A recipient key above is cached. A failed fresh WKD lookup must still
			// prevent encryption instead of silently reusing that cached key.
			view.to(values.target);
			view.cc('');
			const originalFetchJson = rl.fetchJSON;
			rl.fetchJSON = async (url, options, request) => {
				if ('PgpDiscoverPublicKey' === request?.Action && values.target === request.email) {
					return { Action: 'PgpDiscoverPublicKey', Result: false };
				}
				return originalFetchJson(url, options, request);
			};
			try {
				staleCache = plaintextSummary(await view.getMessageRequestParams('', false));
			} finally {
				rl.fetchJSON = originalFetchJson;
			}

			view.to(values.target);
			view.cc('');
			const originalEncrypt = openpgp.encrypt;
			openpgp.encrypt = async () => {
				throw Error('Forced OpenPGP encryption failure');
			};
			try {
				encryptionFailure = plaintextSummary(await view.getMessageRequestParams('', false));
			} finally {
				openpgp.encrypt = originalEncrypt;
			}
		}

		const localDecryptMime = localDecrypt.data || '';
		return {
			encrypted: !!params.encrypted,
			localDecryptStartsEncrypted: /^-----BEGIN PGP MESSAGE-----/.test(localDecryptMime.trim()),
			localDecryptContainsBody: localDecryptMime.includes(btoa('This message is constructed locally and never sent.')),
			packetRecipientKeyIds,
			expected,
			mixed,
			staleCache,
			encryptionFailure
			};
		}, {
			source: source.email,
			target: target.email,
			unencryptableRecipient: 'knappcolin04@gmail.com',
			checkMixedRecipientPolicy
		}));

	await runStep(`${label}: recipient-packet-and-plaintext-policy-assertions`, () => {
		assert(prepared.encrypted, 'Expected browser-side OpenPGP encryption.');
		assert(!prepared.localDecryptStartsEncrypted && prepared.localDecryptContainsBody,
			'Browser-produced ciphertext must decrypt to the original MIME content, never another PGP message.');
		assert.deepStrictEqual(
			prepared.packetRecipientKeyIds,
			prepared.expected.map(item => item.keyId).sort(),
			'Encrypted output must contain the sender and recipient encryption subkey packets.'
		);
		assert(prepared.expected.some(item => item.email === source.email), 'Missing sender encrypt-to-self key.');
		assert(prepared.expected.some(item => item.email === target.email), 'Missing recipient WKD key.');
		if (checkMixedRecipientPolicy) {
			assert(prepared.mixed, 'A mixed-recipient policy result is required.');
			assert(!prepared.mixed.encrypted && !prepared.mixed.signed && !prepared.mixed.autocrypt.length,
				'A mixed recipient message must remain plaintext instead of partially encrypting to known recipients.');
			assert(prepared.mixed.plain.includes('This message is constructed locally and never sent.'),
				'Mixed recipient fallback must preserve the plaintext message body.');
			assert(prepared.mixed.to.includes(target.email),
				'Mixed recipient fallback must retain the encryptable recipient in the message.');
			assert(prepared.mixed.cc.includes('knappcolin04@gmail.com'),
				'Mixed recipient fallback must retain the non-encryptable recipient in the message.');
			assert.match(prepared.mixed.notice, /sent in plaintext/i,
				'Mixed recipient fallback must warn that the complete message will be plaintext.');
			assert(prepared.staleCache && !prepared.staleCache.encrypted && !prepared.staleCache.signed
				&& !prepared.staleCache.autocrypt.length,
				'A cached recipient key must not bypass a failed fresh WKD lookup by encrypting with stale material.');
			assert.match(prepared.staleCache.notice, /sent in plaintext/i,
				'A stale-key fallback must warn that the complete message will be plaintext.');
			assert(prepared.encryptionFailure && !prepared.encryptionFailure.encrypted && !prepared.encryptionFailure.signed
				&& !prepared.encryptionFailure.autocrypt.length,
				'A browser OpenPGP failure must return a plaintext message instead of stopping delivery.');
			assert(prepared.encryptionFailure.plain.includes('This message is constructed locally and never sent.'),
				'A browser OpenPGP failure must restore the original plaintext message body.');
			assert.match(prepared.encryptionFailure.notice, /sent in plaintext/i,
				'A browser OpenPGP failure must warn that the message will be plaintext.');
		}
		report.directions ||= {};
		report.directions[label] = {
			packetRecipientKeyIds: prepared.packetRecipientKeyIds,
			expectedRecipientKeyIds: prepared.expected.map(item => item.keyId).sort()
		};
	});
};

const verifyNamedMultiRecipientWkdPackets = async (compose, source, label) => {
	const prepared = await compose.evaluate(async (element, values) => {
		const view = ko.dataFor(element),
			originalFetchJson = rl.fetchJSON;
		let sendAttempts = 0;
		rl.fetchJSON = async (url, options, request) => {
			if ('SendMessage' === request?.Action) {
				++sendAttempts;
				throw Error('Named recipient packet test must not send mail.');
			}
			return originalFetchJson(url, options, request);
		};
		try {
			view.to(values.to);
			view.cc(values.cc);
			view.bcc(values.bcc);
			view.subject(values.subject);
			view.editor(editor => editor.setPlain(values.body));
			const params = await view.getMessageRequestParams('', false);
			const packetRecipientKeyIds = (await openpgp.readMessage({ armoredMessage: params.encrypted || '' }))
				.getEncryptionKeyIDs()
				.map(keyId => keyId.toHex().toUpperCase())
				.sort();
			const expected = await Promise.all((params.autocrypt || []).map(async header => {
				const armoredKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n'
					+ header.keydata.trim()
					+ '\n-----END PGP PUBLIC KEY BLOCK-----';
				const key = await openpgp.readKey({ armoredKey });
				return {
					email: header.addr,
					keyId: (await key.getEncryptionKey()).getKeyID().toHex().toUpperCase()
				};
			}));
			return {
				encrypted: !!params.encrypted,
				packetRecipientKeyIds,
				expected,
				to: params.to,
				cc: params.cc,
				bcc: params.bcc,
				sendAttempts
			};
		} finally {
			rl.fetchJSON = originalFetchJson;
		}
	}, {
		to: namedWkdRecipients.slice(0, 2).join(', '),
		cc: namedWkdRecipients.slice(2, 4).join(', '),
		bcc: namedWkdRecipients.slice(4).join(', '),
		subject: `OpenPGP named WKD recipients ${Date.now()}`,
		body: `OpenPGP named WKD construction ${Date.now()}`
	});

	assert(prepared.encrypted, 'Every named WKD recipient must produce one encrypted message.');
	assert.strictEqual(prepared.sendAttempts, 0, 'Named WKD packet coverage must never send a real email.');
	assert.deepStrictEqual(
		prepared.expected.map(item => item.email).sort(),
		[source.email, ...namedWkdRecipients].sort(),
		'Each named To/Cc/Bcc recipient and the sender must supply an encryption key.'
	);
	assert.deepStrictEqual(
		prepared.packetRecipientKeyIds,
		prepared.expected.map(item => item.keyId).sort(),
		'One packet must be present for every named recipient and encrypt-to-self key.'
	);
	assert.strictEqual(new Set(prepared.packetRecipientKeyIds).size, prepared.expected.length,
		'Each named recipient must use a distinct encryption packet.');
	report.namedMultiRecipient = {
		label,
		recipients: namedWkdRecipients,
		packetRecipientKeyIds: prepared.packetRecipientKeyIds,
		expectedRecipientKeyIds: prepared.expected.map(item => item.keyId).sort(),
		noSend: true
	};
};

const verifyPlaintextConfirmation = async (page, compose, target, label) => {
	const gmail = 'knappcolin04@gmail.com';
	const token = `OpenPGP plaintext decision ${Date.now()}`;
	const observedSendRequests = [];
	const observeRequest = request => {
		if ('SendMessage' === requestAction(request)) {
			observedSendRequests.push(request);
		}
	};
	page.on('request', observeRequest);
	try {
		await compose.evaluate(element => {
			window.__snappyPlaintextFetchJSON = rl.fetchJSON;
			window.__snappyPlaintextSendCalls = [];
			rl.fetchJSON = async (url, options, request) => {
				if ('SendMessage' === request?.Action) {
					window.__snappyPlaintextSendCalls.push(JSON.parse(JSON.stringify(request)));
					return { Action: 'SendMessage', Result: true };
				}
				return window.__snappyPlaintextFetchJSON(url, options, request);
			};
		});

		const variants = [
			{ to: gmail, cc: '', bcc: '', cancelWithEscape: false },
			{ to: target.email, cc: gmail, bcc: '', cancelWithEscape: true },
			{ to: target.email, cc: '', bcc: gmail, cancelWithEscape: false }
		];
		for (const variant of variants) {
			await compose.evaluate((element, values) => {
				const view = ko.dataFor(element);
				view.to(values.to);
				view.cc(values.cc);
				view.bcc(values.bcc);
				view.subject(values.subject);
				view.editor(editor => editor.setPlain(values.body));
				view.sendCommand();
			}, { ...variant, subject: token, body: token });

			const ask = page.locator('#V-PopupsAsk');
			await ask.waitFor({ state: 'visible', timeout: 30000 });
			assert.match(await ask.innerText(), /plaintext/i, 'Plaintext fallback must require an explicit decision.');
			assert.match(await ask.locator('.buttonYes').innerText(), /send plaintext/i);
			assert.match(await ask.locator('.buttonNo').innerText(), /cancel/i);
			await page.waitForFunction(() => document.activeElement?.matches('#V-PopupsAsk .buttonNo'), null, { timeout: 5000 });
			assert.strictEqual(await compose.evaluate(element => ko.dataFor(element).sending()), true,
				'Sending must remain locked while the plaintext confirmation is visible.');

			if (variant.cancelWithEscape) {
				await page.keyboard.press('Escape');
			} else {
				await ask.locator('.buttonNo').click();
			}
			await ask.waitFor({ state: 'hidden', timeout: 10000 });
			await page.waitForTimeout(250);
			const preserved = await compose.evaluate(element => {
				const view = ko.dataFor(element);
				return {
					sending: view.sending(),
					to: view.to(),
					cc: view.cc(),
					bcc: view.bcc(),
					body: view.oEditor.getData()
				};
			});
			assert.deepStrictEqual(preserved, {
				sending: false,
				to: variant.to,
				cc: variant.cc,
				bcc: variant.bcc,
				body: token
			}, 'Cancel must preserve the plaintext compose without sending it.');
			assert.strictEqual(observedSendRequests.length, 0, 'Cancel must make no SendMessage request.');
			assert.strictEqual(await compose.evaluate(() => window.__snappyPlaintextSendCalls.length), 0,
				'Cancel must not reach the SendMessage transport hook.');
		}

		await compose.evaluate((element, values) => {
			const view = ko.dataFor(element);
			view.to(values.to);
			view.cc(values.cc);
			view.bcc(values.bcc);
			view.subject(values.subject);
			view.editor(editor => editor.setPlain(values.body));
			view.sendCommand();
		}, { to: target.email, cc: '', bcc: gmail, subject: token, body: token });
		const ask = page.locator('#V-PopupsAsk');
		await ask.waitFor({ state: 'visible', timeout: 30000 });
		await ask.locator('.buttonYes').click();
		await compose.waitFor({ state: 'hidden', timeout: 30000 });
		const sendCalls = await compose.evaluate(() => window.__snappyPlaintextSendCalls);
		assert.strictEqual(observedSendRequests.length, 0,
			'The plaintext confirmation test must not make a real SendMessage network request.');
		assert.strictEqual(sendCalls.length, 1, 'Explicit plaintext confirmation must make exactly one SendMessage attempt.');
		assert.strictEqual(sendCalls[0].to, target.email);
		assert.strictEqual(sendCalls[0].cc, '');
		assert.strictEqual(sendCalls[0].bcc, gmail);
		assert.strictEqual(sendCalls[0].plain, token);
		assert(!sendCalls[0].encrypted && !sendCalls[0].signed && !(sendCalls[0].autocrypt || []).length,
			'Explicit plaintext confirmation must preserve the whole plaintext recipient set without crypto fields.');
		report.directions ||= {};
		report.directions[label] = { ...report.directions[label], plaintextConfirmation: 'To/Cc/Bcc cancel and explicit-send branches passed' };
	} finally {
		await compose.evaluate(() => {
			if (window.__snappyPlaintextFetchJSON) {
				rl.fetchJSON = window.__snappyPlaintextFetchJSON;
				delete window.__snappyPlaintextFetchJSON;
				delete window.__snappyPlaintextSendCalls;
			}
		}).catch(() => {});
		page.off('request', observeRequest);
	}
};

const runDirection = async (browser, source, target, label, checkMixedRecipientPolicy = false, checkPlaintextConfirmation = false) => {
	const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
	let page = null;
	try {
		page = await context.newPage();
		attachPageDiagnostics(page);
		await runStep(`${label}: sender-login`, () => login(page, source));
		if ('nixc-to-boompay' === label) {
			await runStep('proton-wkd-zero-touch', () => verifyZeroTouchProtonWkd(page));
		}
		const compose = await runStep(`${label}: open-compose`, () => openCompose(page));
		await verifyRecipientPolicyAndPacketBuild(compose, source, target, label, checkMixedRecipientPolicy);
		if (checkPlaintextConfirmation) {
			await runStep(`${label}: named-wkd-multirecipient-packet`, () =>
				verifyNamedMultiRecipientWkdPackets(compose, source, label));
		}
		await runStep(`${label}: close-preparation-compose`, () => closeCompose(page, compose));
		if (checkPlaintextConfirmation) {
			const plaintextCompose = await runStep(`${label}: open-plaintext-confirmation-compose`, () => openCompose(page));
			await runStep(`${label}: plaintext-confirmation-abort-and-send`, () =>
				verifyPlaintextConfirmation(page, plaintextCompose, target, label));
		}
		const message = await runStep(`${label}: encrypted-send`, () => sendEncryptedQaMessage(page, target.email, label));
		await runStep(`${label}: sender-sent-copy-decrypt-and-verify`, () =>
			verifySentCopy(browser, source, message, label, checkPlaintextConfirmation));
		await runStep(`${label}: recipient-decrypt-and-plaintext-forward`, () => verifyForwardUsesPlaintext(browser, target, message, label));
	} catch (error) {
		await capturePageFailure(`${label}: sender`, page);
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
		await runDirection(browser, sender, recipient, 'nixc-to-boompay', true, true);
		await runDirection(browser, recipient, sender, 'boompay-to-nixc', true);
		const reportFile = writeReport('passed');
		console.log('OpenPGP send contract passed in both directions: recipient packets verified, mixed recipients stayed whole and plaintext, and forwarding verified.');
		reportFile && console.log('OpenPGP contract report: ' + relativePath(reportFile));
	} catch (error) {
		const reportFile = writeReport('failed', error);
		reportFile && console.error('OpenPGP contract report: ' + relativePath(reportFile));
		throw error;
	} finally {
		await browser?.close();
	}
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
