const fs = require('fs');
const path = require('path');
const { test, chromium } = require('@playwright/test');

const envFile = process.env.SNAPPYMAIL_AUDIT_ENV || '/Users/aedev/.config/codex/snappymail-miab-audit-users.env';
const runId = process.env.SNAPPYMAIL_AUDIT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = path.resolve(__dirname, '../../tmp/email-client-audit', runId);
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '';
const lifecycleStateFile = path.resolve(__dirname, '../../tmp/email-client-audit/lifecycle-state.json');
const selectedCases = new Set((process.env.SNAPPYMAIL_AUDIT_CASES || '').split(',').map(value => value.trim()).filter(Boolean));
const selectedDomains = new Set((process.env.SNAPPYMAIL_AUDIT_DOMAINS || '').split(',').map(value => value.trim()).filter(Boolean));
const defaultCases = new Set(['route', 'baseline', 'selection', 'mailbox-actions', 'message-view', 'list-navigation', 'session', 'drafts', 'crypto', 'cross-domain', 'accounts', 'mobile', 'keyboard']);
const wantsCase = name => selectedCases.size ? selectedCases.has(name) : defaultCases.has(name);
const wantsAccount = account => !selectedDomains.size || selectedDomains.has(account.domain);

const parseEnvFile = file => {
	const result = {};
	if (!fs.existsSync(file)) {
		throw new Error(`Missing audit env file: ${file}`);
	}
	for (const line of fs.readFileSync(file, 'utf8').split(/\n/)) {
		const match = line.match(/^export\s+([A-Z0-9_]+)='([^']*)'$/);
		if (match) {
			result[match[1]] = match[2];
		}
	}
	return result;
};

const secrets = parseEnvFile(envFile);
const accounts = [
	{
		label: 'boompay-a',
		domain: 'boompay.ca',
		baseURL: process.env.SNAPPYMAIL_AUDIT_BOOMPAY_URL || 'https://mail.boompay.ca',
		email: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_A_EMAIL,
		password: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_A_PASSWORD
	},
	{
		label: 'boompay-b',
		domain: 'boompay.ca',
		baseURL: process.env.SNAPPYMAIL_AUDIT_BOOMPAY_URL || 'https://mail.boompay.ca',
		email: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_B_EMAIL,
		password: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_B_PASSWORD
	},
	{
		label: 'nixc-a',
		domain: 'nixc.us',
		baseURL: process.env.SNAPPYMAIL_AUDIT_NIXC_URL || 'https://mail.nixc.us',
		email: secrets.SNAPPYMAIL_AUDIT_NIXC_A_EMAIL,
		password: secrets.SNAPPYMAIL_AUDIT_NIXC_A_PASSWORD
	},
	{
		label: 'nixc-b',
		domain: 'nixc.us',
		baseURL: process.env.SNAPPYMAIL_AUDIT_NIXC_URL || 'https://mail.nixc.us',
		email: secrets.SNAPPYMAIL_AUDIT_NIXC_B_EMAIL,
		password: secrets.SNAPPYMAIL_AUDIT_NIXC_B_PASSWORD
	}
];
const freshAccounts = [
	{
		label: 'boompay-fresh',
		domain: 'boompay.ca',
		baseURL: process.env.SNAPPYMAIL_AUDIT_BOOMPAY_URL || 'https://mail.boompay.ca',
		email: 'snappyqa-fresh@boompay.ca',
		password: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_A_PASSWORD
	},
	{
		label: 'nixc-fresh',
		domain: 'nixc.us',
		baseURL: process.env.SNAPPYMAIL_AUDIT_NIXC_URL || 'https://mail.nixc.us',
		email: 'snappyqa-fresh@nixc.us',
		password: secrets.SNAPPYMAIL_AUDIT_NIXC_A_PASSWORD
	}
];
const rotationAccounts = [
	{
		label: 'boompay-rotate',
		domain: 'boompay.ca',
		baseURL: process.env.SNAPPYMAIL_AUDIT_BOOMPAY_URL || 'https://mail.boompay.ca',
		email: 'snappyqa-rotate@boompay.ca',
		password: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_A_PASSWORD,
		rotatedPassword: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_B_PASSWORD
	},
	{
		label: 'nixc-rotate',
		domain: 'nixc.us',
		baseURL: process.env.SNAPPYMAIL_AUDIT_NIXC_URL || 'https://mail.nixc.us',
		email: 'snappyqa-rotate@nixc.us',
		password: secrets.SNAPPYMAIL_AUDIT_NIXC_A_PASSWORD,
		rotatedPassword: secrets.SNAPPYMAIL_AUDIT_NIXC_B_PASSWORD
	}
];
const includesFreshAccounts = selectedCases.has('bootstrap') || selectedCases.has('cross-domain');
const includesRotationAccounts = selectedCases.has('lifecycle-prepare') || selectedCases.has('lifecycle-verify');
const reportAccounts = [
	...accounts,
	...(includesFreshAccounts ? freshAccounts : []),
	...(includesRotationAccounts ? rotationAccounts : [])
];
const missing = [...accounts, ...freshAccounts, ...rotationAccounts].flatMap(account =>
	['email', 'password'].filter(field => !account[field]).map(field => `${account.label}.${field}`)
).concat(rotationAccounts.filter(account => !account.rotatedPassword).map(account => `${account.label}.rotatedPassword`));
if (missing.length) {
	throw new Error(`Missing audit account values: ${missing.join(', ')}`);
}

test.use({
	ignoreHTTPSErrors: true,
	launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {}
});

const mkdir = dir => fs.mkdirSync(dir, { recursive: true });
const rel = file => path.relative(process.cwd(), file);
const recordFailure = (audit, start, entry) => audit.record({
	...entry,
	status: audit.records.slice(start).some(record => 'error' === record.status) ? 'observed' : 'error'
});

const Audit = class {
	constructor() {
		this.records = [];
		mkdir(artifactRoot);
	}

	record(entry) {
		this.records.push({
			at: new Date().toISOString(),
			...entry
		});
	}

	async time(label, fn) {
		const start = Date.now();
		try {
			const result = await fn();
			this.record({ label, status: 'ok', ms: Date.now() - start });
			return result;
		} catch (error) {
			this.record({ label, status: 'error', ms: Date.now() - start, error: error.message });
			throw error;
		}
	}

	async screenshot(page, name, options = {}) {
		const file = path.join(artifactRoot, `${name}.png`);
		try {
			if (page.isClosed()) {
				throw new Error('page closed');
			}
			await page.screenshot({ path: file, fullPage: true, timeout: 10000, ...options });
			this.record({ label: `screenshot:${name}`, status: 'ok', path: rel(file) });
			return file;
		} catch (error) {
			this.record({ label: `screenshot:${name}`, status: 'unavailable', error: error.message });
			return null;
		}
	}

	writeReport() {
		const jsonFile = path.join(artifactRoot, 'audit.json');
		const mdFile = path.join(artifactRoot, 'report.md');
		const errors = this.records.filter(record => 'error' === record.status);
		fs.writeFileSync(jsonFile, JSON.stringify({
			runId,
			artifactRoot: rel(artifactRoot),
			accounts: reportAccounts.map(({ label, domain, baseURL, email }) => ({ label, domain, baseURL, email })),
			records: this.records
		}, null, 2));

		const lines = [
			'# SnappyMail Email Client Audit',
			'',
			`Run: ${runId}`,
			`Artifacts: ${rel(artifactRoot)}`,
			`Recorded steps: ${this.records.length}; errors: ${errors.length}`,
			'',
			'## Accounts',
			'',
			'| Label | Domain | URL | Email |',
			'| --- | --- | --- | --- |',
			...reportAccounts.map(account => `| ${account.label} | ${account.domain} | ${account.baseURL} | ${account.email} |`),
			'',
			'## Timeline',
			'',
			'| Step | Status | ms | Evidence | Notes |',
			'| --- | --- | ---: | --- | --- |',
			...this.records.map(record => [
				record.label,
				record.status,
				record.ms ?? '',
				record.path || '',
				record.error || record.note || ''
			].map(value => String(value).replace(/\|/g, '\\|')).join(' | ')).map(row => `| ${row} |`),
			'',
			'## Observed Failures',
			'',
			...(errors.length
				? errors.map(record => `- ${record.label}: ${record.error || record.note || 'unspecified error'}`)
				: ['- None recorded.'])
		];
		fs.writeFileSync(mdFile, `${lines.join('\n')}\n`);
		return { jsonFile, mdFile };
	}
};

const waitForMailboxList = page => page.waitForFunction(() =>
	document.querySelectorAll('.messageListItem').length
	|| document.body.innerText.includes('Empty list.')
, null, { timeout: 45000 });

const login = async (page, account, audit) => {
	page.setDefaultTimeout(15000);
	page.setDefaultNavigationTimeout(45000);
	const response = await audit.time(`${account.label}:goto-login`, () =>
		page.goto(account.baseURL, { waitUntil: 'commit', timeout: 20000 })
	);
	audit.record({
		label: `${account.label}:login-response`,
		status: response ? 'ok' : 'error',
		note: response ? `HTTP ${response.status()}` : 'No HTTP response returned.'
	});
	await audit.time(`${account.label}:login-form-ready`, () =>
		page.locator('input[name=Email]').waitFor({ state: 'visible', timeout: 30000 })
	);
	await audit.screenshot(page, `${account.label}-login-before`);
	await page.locator('input[name=Email]').fill(account.email);
	await page.locator('input[name=Password]').fill(account.password);
	await audit.time(`${account.label}:login-submit`, async () => {
		await page.locator('.buttonLogin').click();
		await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true, null, { timeout: 90000 });
		await page.waitForSelector('#rl-content:not([hidden])', { timeout: 45000 });
		await waitForMailboxList(page);
	});
	await audit.screenshot(page, `${account.label}-mailbox`);
	await completeIdentityOnboarding(page, account, audit);
};

const waitForSettledDialog = async (page, dialog) => page.waitForFunction(element => {
	const box = element.getBoundingClientRect();
	return element.classList.contains('animate') && box.top >= 0 && box.height > 0;
}, await dialog.elementHandle(), { timeout: 5000 });

const completeIdentityOnboarding = async (page, account, audit, waitMs = 0) => {
	const modal = page.locator('#V-PopupsIdentity');
	let visible = await modal.isVisible().catch(() => false);
	if (!visible && waitMs) {
		visible = await modal.waitFor({ state: 'visible', timeout: waitMs })
			.then(() => true)
			.catch(() => false);
	}
	if (!visible) {
		return false;
	}

	await waitForSettledDialog(page, modal);
	audit.record({ label: `${account.label}:identity-onboarding-visible`, status: 'ok', note: 'Edit Identity modal blocked mailbox actions on first login.' });
	await audit.screenshot(page, `${account.label}-identity-onboarding`);
	const name = `Snappy Audit ${account.label}`;
	await modal.locator('input[name=Name]').fill(name);
	await audit.time(`${account.label}:identity-onboarding-save`, async () => {
		await modal.locator('button.buttonAddIdentity').click();
		await modal.waitFor({ state: 'hidden', timeout: 15000 });
	});
	await audit.screenshot(page, `${account.label}-after-identity-onboarding`);
	return true;
};

const openCompose = async (page, account, audit, label = account.label) => audit.time(`${label}:open-compose`, async () => {
	await waitForMailboxList(page);
	await completeIdentityOnboarding(page, account, audit);
	const button = page.locator('#rl-left .buttonCompose:visible, #V-MailMessageList .buttonCompose:visible').first();
	try {
		await button.click({ timeout: 15000 });
	} catch (error) {
		if (!await completeIdentityOnboarding(page, account, audit, 5000)) {
			throw error;
		}
		await button.click({ timeout: 15000 });
	}
	const compose = page.locator('#V-PopupsCompose');
	await compose.waitFor({ state: 'visible', timeout: 15000 });
	await waitForSettledDialog(page, compose);
	return compose;
});

const closeCompose = async (page, compose) => {
	await compose.locator('header > .pull-right > a.close').click();
	await page.waitForFunction(element => !ko.dataFor(element)?.modalVisible?.(), await compose.elementHandle(), { timeout: 15000 });
	await compose.waitFor({ state: 'hidden', timeout: 15000 });
};

const inspectState = async (page, label, audit) => {
	const state = await page.evaluate(() => ({
		auth: window.rl?.settings?.get?.('Auth') === true,
		title: document.title,
		theme: window.rl?.settings?.get?.('Theme'),
		bodyText: document.body.innerText.slice(0, 2000),
		messageCount: document.querySelectorAll('.messageListItem').length,
		hasVisibleAskPopup: !!document.querySelector('#V-PopupsAsk:not([hidden])')
	}));
	audit.record({ label: `${label}:state`, status: 'ok', note: JSON.stringify({
		auth: state.auth,
		title: state.title,
		theme: state.theme,
		messageCount: state.messageCount,
		hasVisibleAskPopup: state.hasVisibleAskPopup
	}) });
	return state;
};

const probePublicRoute = async (account, audit, label, args = [], attempts = 1) => {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const attemptLabel = `${label}:${account.label}:attempt-${attempt}`;
		const browser = await chromium.launch({
			args,
			...(chromiumExecutable ? { executablePath: chromiumExecutable } : {})
		});
		try {
			const context = await browser.newContext({ ignoreHTTPSErrors: true });
			const page = await context.newPage();
			const session = await context.newCDPSession(page);
			let protocol = '';
			session.on('Network.responseReceived', event => {
				if ('Document' === event.type && event.response.url === `${account.baseURL}/`) {
					protocol = event.response.protocol || '';
				}
			});
			await session.send('Network.enable');
			try {
				const response = await audit.time(attemptLabel, () =>
					page.goto(account.baseURL, { waitUntil: 'commit', timeout: 12000 })
				);
				audit.record({
					label: `${attemptLabel}:response`,
					status: response ? 'ok' : 'error',
					note: response ? `HTTP ${response.status()}; ${protocol || 'unknown protocol'}` : 'No HTTP response returned.'
				});
			} catch (error) {
				audit.record({ label: `${attemptLabel}:failure-observed`, status: 'observed', note: error.message });
			} finally {
				await context.close();
			}
		} finally {
			await browser.close();
		}
	}
};

const messageListState = page => page.locator('#V-MailMessageList').evaluate(element => {
	const view = ko.dataFor(element);
	const list = view?.messageList?.();
	return {
		loaded: list?.length || 0,
		total: view?.messageList?.count?.() || 0,
		page: view?.messageList?.page?.() || 0,
		pageCount: view?.messageList?.pageCount?.() || 0,
		sortText: view?.sortText?.() || '',
		offeringAll: !!view?.selectAllInViewVisible?.(),
		allSelected: !!view?.messageList?.allSelected?.()
	};
});

const openFolder = async (page, folderName) => {
	const folder = page.locator('.b-folders-system a').filter({ hasText: folderName }).first();
	await folder.click();
	await page.waitForFunction(expected => {
		const selected = document.querySelector('.b-folders-system a.selected');
		return selected?.textContent.trim() === expected;
	}, folderName, { timeout: 15000 });
	await waitForMailboxList(page);
};

const selectAllInCurrentView = async (browser, account, audit, scenario = account.label, folderName = 'Inbox') => {
	const evidence = scenario.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	try {
		await login(page, account, audit);
		if ('Inbox' !== folderName) {
			await openFolder(page, folderName);
		}
		const initialState = await messageListState(page);
		if (initialState.total <= initialState.loaded) {
			audit.record({
				label: `${scenario}:${folderName.toLowerCase()}-selection-skipped`,
				status: 'skipped',
				note: `Expected more messages than the ${initialState.loaded}-message page size; found ${initialState.total}.`
			});
			return false;
		}
		const selectAllOffer = page.locator('.listSelectionNotice a.g-ui-link').filter({
			hasText: new RegExp(`^Select all \\d+ messages in ${folderName}$`)
		});
		await audit.time(`${scenario}:select-current-page`, async () => {
			await page.locator('.checkboxCheckAll').click();
			await selectAllOffer.waitFor({ state: 'visible', timeout: 45000 });
		});
		const pageState = await messageListState(page);
		audit.record({ label: `${scenario}:current-page-selection-state`, status: 'ok', note: JSON.stringify(pageState) });
		await audit.screenshot(page, `${evidence}-${folderName.toLowerCase()}-current-page-selected`);
		await audit.time(`${scenario}:select-all-${folderName.toLowerCase()}`, async () => {
			await selectAllOffer.click();
			await page.locator('.listSelectionNotice.allSelected').waitFor({ state: 'visible', timeout: 45000 });
		});
		const allSelectionText = await page.locator('.listSelectionNotice.allSelected').innerText();
		audit.record({ label: `${scenario}:all-${folderName.toLowerCase()}-selection-state`, status: 'ok', note: allSelectionText });
		await audit.screenshot(page, `${evidence}-${folderName.toLowerCase()}-all-selected`);
		await audit.time(`${scenario}:clear-all-${folderName.toLowerCase()}-selection`, async () => {
			await page.locator('.listSelectionNotice.allSelected a.g-ui-link').click();
			await page.locator('.listSelectionNotice.allSelected').waitFor({ state: 'hidden', timeout: 15000 });
		});
		return true;
	} catch (error) {
		await audit.screenshot(page, `${evidence}-bulk-selection-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:bulk-selection-error`, error: error.message });
	} finally {
		await context.close();
	}
	return false;
};

const ensureSpamMessages = async (browser, account, audit, scenario, minimum = 21) => {
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	let ready = false;
	try {
		await login(page, account, audit);
		await openFolder(page, 'Spam');
		let spamState = await messageListState(page);
		if (spamState.total < minimum) {
			await openFolder(page, 'Inbox');
			let remaining = minimum - spamState.total;
			while (remaining > 0) {
				const before = await messageListState(page);
				const take = Math.min(remaining, before.loaded);
				if (!take) {
					throw new Error(`Inbox has no messages available to create the ${minimum}-message Spam fixture.`);
				}
				if (take === before.loaded) {
					await page.locator('.checkboxCheckAll').click();
				} else {
					for (let index = 0; index < take; index += 1) {
						await page.locator('.messageListItem .checkboxMessage').nth(index).click();
					}
				}
				await audit.time(`${scenario}:move-${take}-to-spam`, async () => {
					await page.locator('#V-MailMessageList a[data-i18n*="TO_SPAM"]').first().click();
					await page.waitForFunction(expectedTotal => {
						const view = ko.dataFor(document.querySelector('#V-MailMessageList'));
						return (view?.messageList?.count?.() || 0) <= expectedTotal;
					}, before.total - take, { timeout: 30000 });
				});
				remaining -= take;
			}
			await openFolder(page, 'Spam');
			spamState = await messageListState(page);
		}
		if (spamState.total < minimum) {
			throw new Error(`Spam fixture contains ${spamState.total} messages; expected at least ${minimum}.`);
		}
		audit.record({ label: `${scenario}:spam-fixture-state`, status: 'ok', note: JSON.stringify(spamState) });
		await audit.screenshot(page, `${scenario}-spam-fixture`);
		ready = true;
	} catch (error) {
		await audit.screenshot(page, `${scenario}-spam-fixture-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:spam-fixture-error`, error: error.message });
	} finally {
		await context.close();
	}
	return ready;
};

const fixtureSubjects = async (page, count) => {
	const subjects = (await page.locator('.messageListItem .subjectParent').allTextContents())
		.map(subject => subject.trim())
		.filter(subject => /^Snappy audit fixture /i.test(subject));
	if (subjects.length < count) {
		throw new Error(`Expected at least ${count} seeded Snappy audit messages in Inbox; found ${subjects.length}. Run npm run test:audit:seed first.`);
	}
	return subjects.slice(0, count);
};

const calendarFixtureSubject = async (page, domain) => {
	const prefix = `Snappy audit calendar fixture ${domain}`;
	await page.waitForFunction(expected => [...document.querySelectorAll('.messageListItem .subjectParent')]
		.some(element => element.textContent.trim().startsWith(expected)), prefix, { timeout: 60000 });
	const subjects = (await page.locator('.messageListItem .subjectParent').allTextContents())
		.map(subject => subject.trim())
		.filter(subject => subject.startsWith(prefix));
	if (!subjects.length) {
		throw new Error(`Calendar fixture was not available for ${domain}. Run npm run test:audit:calendar.`);
	}
	return subjects[0];
};

const messageItemForSubject = (page, subject) => page.locator('.messageListItem').filter({ hasText: subject }).first();

const searchQueryForFixture = subject => {
	const runId = subject.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/)?.[0];
	const action = subject.match(/\baction-\d+\b/)?.[0];
	return runId && action ? `${runId} ${action}` : subject.split(' ').slice(0, 4).join(' ');
};

const waitForSubject = (page, subject, visible, timeout = 45000) => page.waitForFunction(
	({ expectedSubject, expectedVisible }) => {
		const found = [...document.querySelectorAll('.messageListItem .subjectParent')]
			.some(element => element.textContent.trim() === expectedSubject);
		return found === expectedVisible;
	},
	{ expectedSubject: subject, expectedVisible: visible },
	{ timeout }
);

const assertSubjectInCurrentFolder = async (page, subject) => {
	if (await messageItemForSubject(page, subject).isVisible().catch(() => false)) {
		return;
	}
	const search = page.locator('.inputSearch');
	await search.fill(searchQueryForFixture(subject));
	await search.press('Enter');
	await waitForSubject(page, subject, true);
	await page.locator('.closeSearch').click();
	await page.waitForFunction(() => {
		const description = document.querySelector('.listSearchDesc');
		return !description || 'none' === getComputedStyle(description).display;
	}, null, { timeout: 15000 });
};

const selectMessageBySubject = async (page, subject) => {
	await waitForSubject(page, subject, true);
	const selectedRows = page.locator('.messageListItem.checked');
	for (let index = await selectedRows.count() - 1; index >= 0; index -= 1) {
		const selectedRow = selectedRows.nth(index);
		if (subject !== (await selectedRow.locator('.subjectParent').innerText()).trim()) {
			await selectedRow.locator('.checkboxMessage').click();
		}
	}
	const row = messageItemForSubject(page, subject);
	if (!await row.evaluate(element => !!ko.dataFor(element)?.checked?.())) {
		await row.locator('.checkboxMessage').click();
	}
	await page.waitForFunction(expectedSubject => {
		const subjectElement = [...document.querySelectorAll('.messageListItem .subjectParent')]
			.find(element => element.textContent.trim() === expectedSubject);
		return !!subjectElement && !!ko.dataFor(subjectElement.closest('.messageListItem'))?.checked?.();
	}, subject, { timeout: 15000 });
	return row;
};

const openMoreListMenu = async page => {
	const menu = page.locator('#V-MailMessageList menu[aria-labelledby="more-list-dropdown-id"]');
	if (!await menu.isVisible().catch(() => false)) {
		await page.locator('#more-list-dropdown-id').click();
		await menu.waitFor({ state: 'visible', timeout: 15000 });
	}
	return menu;
};

const clickMoreListAction = async (page, i18n) => {
	const menu = await openMoreListMenu(page);
	const action = menu.locator(`li:not(.disabled) a[data-i18n="${i18n}"]`);
	await action.waitFor({ state: 'visible', timeout: 15000 });
	await action.click();
};

const waitForMessageUnseen = (page, subject, unseen) => page.waitForFunction(
	({ expectedSubject, expectedUnseen }) => {
		const subjectElement = [...document.querySelectorAll('.messageListItem .subjectParent')]
			.find(element => element.textContent.trim() === expectedSubject);
		return !!subjectElement && subjectElement.closest('.messageListItem').classList.contains('unseen') === expectedUnseen;
	},
	{ expectedSubject: subject, expectedUnseen: unseen },
	{ timeout: 45000 }
);

const setMessageSeen = async (page, subject, seen) => {
	await selectMessageBySubject(page, subject);
	await clickMoreListAction(page, seen ? 'MESSAGE_LIST/MENU_SET_SEEN' : 'MESSAGE_LIST/MENU_UNSET_SEEN');
	await waitForMessageUnseen(page, subject, !seen);
};

const clickListToolbarAction = async (page, title) => {
	const action = page.locator(`#V-MailMessageList .btn-toolbar a[title="${title}"]:visible`).first();
	await action.waitFor({ state: 'visible', timeout: 15000 });
	await action.click();
};

const moveSelectedMessageToFolder = async (page, folderName) => {
	await clickListToolbarAction(page, 'Move To');
	try {
		await page.waitForFunction(() => !!ko.dataFor(document.querySelector('.b-folders'))?.moveAction?.(), null, { timeout: 2000 });
	} catch (error) {
		throw new Error('Move To did not enter destination mode after the selected-message toolbar click.');
	}
	const folder = page.locator('.b-folders-system a.selectable').filter({ hasText: folderName }).first();
	await folder.waitFor({ state: 'visible', timeout: 15000 });
	await folder.click();
	await page.waitForFunction(() => !ko.dataFor(document.querySelector('.b-folders'))?.moveAction?.(), null, { timeout: 15000 });
};

const auditMailboxActions = async (browser, account, audit) => {
	const scenario = `mailbox-actions-${account.label}`;
	const evidence = scenario.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	try {
		await login(page, account, audit);
		const [statusSubject, archiveSubject, spamSubject, trashSubject] = await fixtureSubjects(page, 4);
		await audit.screenshot(page, `${evidence}-inbox-fixtures`);

		const beforeReload = await messageListState(page);
		await audit.time(`${scenario}:reload`, async () => {
			await clickListToolbarAction(page, 'Reload Message List');
			await page.waitForFunction(() => {
				const view = ko.dataFor(document.querySelector('#V-MailMessageList'));
				return !view?.messageList?.isLoading?.() && !!view?.messageList?.().length;
			}, null, { timeout: 45000 });
		});
		const afterReload = await messageListState(page);
		if (!afterReload.loaded || afterReload.total < beforeReload.total) {
			throw new Error(`Reload left an incomplete message list: ${JSON.stringify({ beforeReload, afterReload })}`);
		}
		audit.record({ label: `${scenario}:reload-state`, status: 'ok', note: JSON.stringify({ beforeReload, afterReload }) });

		const searchQuery = searchQueryForFixture(statusSubject);
		await audit.time(`${scenario}:search`, async () => {
			const search = page.locator('.inputSearch');
			await search.fill(searchQuery);
			await search.press('Enter');
			await page.waitForFunction(({ expectedSubject, expectedQuery }) => {
				const searchDescription = document.querySelector('.listSearchDesc')?.textContent || '';
				const found = [...document.querySelectorAll('.messageListItem .subjectParent')]
					.some(element => element.textContent.trim() === expectedSubject);
				return searchDescription.includes(expectedQuery) && found;
			}, { expectedSubject: statusSubject, expectedQuery: searchQuery }, { timeout: 45000 });
		});
		await audit.screenshot(page, `${evidence}-search-results`);
		await audit.time(`${scenario}:clear-search`, async () => {
			await page.locator('.closeSearch').click();
			await page.waitForFunction(() => {
				const description = document.querySelector('.listSearchDesc');
				return !description || 'none' === getComputedStyle(description).display;
			}, null, { timeout: 15000 });
			await waitForSubject(page, statusSubject, true);
		});

		const initialUnseen = await messageItemForSubject(page, statusSubject).evaluate(element => element.classList.contains('unseen'));
		await audit.time(`${scenario}:mark-unread`, () => setMessageSeen(page, statusSubject, false));
		await audit.screenshot(page, `${evidence}-marked-unread`);
		await audit.time(`${scenario}:mark-read`, () => setMessageSeen(page, statusSubject, true));
		if (initialUnseen) {
			await audit.time(`${scenario}:restore-unread`, () => setMessageSeen(page, statusSubject, false));
		}

		const runAction = async (label, action) => {
			const actionStart = audit.records.length;
			try {
				await action();
				return true;
			} catch (error) {
				await audit.screenshot(page, `${evidence}-${label}-error`);
				recordFailure(audit, actionStart, { label: `${scenario}:${label}-error`, error: error.message });
				return false;
			}
		};

		const archiveReady = await runAction('archive', async () => {
			await selectMessageBySubject(page, archiveSubject);
			await audit.time(`${scenario}:archive`, async () => {
				await clickListToolbarAction(page, 'Archive');
				await waitForSubject(page, archiveSubject, false);
			});
			await audit.time(`${scenario}:open-archive`, () => openFolder(page, 'Archive'));
			await assertSubjectInCurrentFolder(page, archiveSubject);
			await audit.screenshot(page, `${evidence}-archived`);
		});

		await runAction('trash', async () => {
			await audit.time(`${scenario}:open-inbox-before-trash`, () => openFolder(page, 'Inbox'));
			await selectMessageBySubject(page, trashSubject);
			await audit.time(`${scenario}:trash`, async () => {
				await clickListToolbarAction(page, 'Delete');
				await waitForSubject(page, trashSubject, false);
			});
			await audit.time(`${scenario}:open-trash`, () => openFolder(page, 'Trash'));
			await assertSubjectInCurrentFolder(page, trashSubject);
			await audit.screenshot(page, `${evidence}-trash`);
		});

		await runAction('spam', async () => {
			await audit.time(`${scenario}:open-inbox-before-spam`, () => openFolder(page, 'Inbox'));
			await selectMessageBySubject(page, spamSubject);
			await audit.time(`${scenario}:spam`, async () => {
				await clickListToolbarAction(page, 'Move message(s) to Spam');
				await waitForSubject(page, spamSubject, false, 30000);
			});
			await audit.time(`${scenario}:open-spam`, () => openFolder(page, 'Spam'));
			await assertSubjectInCurrentFolder(page, spamSubject);
			await audit.screenshot(page, `${evidence}-spam`);
			await selectMessageBySubject(page, spamSubject);
			await audit.time(`${scenario}:restore-not-spam`, async () => {
				await clickListToolbarAction(page, 'Not Spam');
				await waitForSubject(page, spamSubject, false);
			});
			await audit.time(`${scenario}:open-inbox-after-spam`, () => openFolder(page, 'Inbox'));
			await assertSubjectInCurrentFolder(page, spamSubject);
		});

		if (archiveReady) {
			await runAction('move', async () => {
				await audit.time(`${scenario}:open-archive-before-move`, () => openFolder(page, 'Archive'));
				await selectMessageBySubject(page, archiveSubject);
				await audit.time(`${scenario}:restore-archive-with-move`, async () => {
					await moveSelectedMessageToFolder(page, 'Inbox');
					await waitForSubject(page, archiveSubject, false);
				});
				await audit.time(`${scenario}:open-inbox-after-move`, () => openFolder(page, 'Inbox'));
				await assertSubjectInCurrentFolder(page, archiveSubject);
				await audit.screenshot(page, `${evidence}-restored-inbox`);
			});
		}
	} catch (error) {
		await audit.screenshot(page, `${evidence}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

const openMessageBySubject = async (page, subject) => {
	await waitForSubject(page, subject, true);
	await messageItemForSubject(page, subject).locator('.subjectParent').click();
	await page.waitForFunction(expectedSubject => {
		const view = ko.dataFor(document.querySelector('#V-MailMessageView'));
		return view?.message?.()?.subject?.() === expectedSubject && !view?.messageLoadingThrottle?.();
	}, subject, { timeout: 60000 });
};

const auditMessageView = async (browser, account, audit) => {
	const scenario = `message-view-${account.label}`;
	const evidence = scenario.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	try {
		await login(page, account, audit);
		const [subject] = await fixtureSubjects(page, 1);
		await audit.time(`${scenario}:open`, () => openMessageBySubject(page, subject));
		const state = await page.locator('#V-MailMessageView').evaluate(element => {
			const view = ko.dataFor(element);
			const message = view?.message?.();
			const text = element.innerText;
			return {
				subject: message?.subject?.() || '',
				hasFixtureBody: text.includes('Seeded audit message'),
				messageError: view?.messageError?.() || '',
				loading: !!view?.messageLoadingThrottle?.()
			};
		});
		if (state.subject !== subject || !state.hasFixtureBody || state.messageError || state.loading) {
			throw new Error(`Message view did not render the selected fixture: ${JSON.stringify(state)}`);
		}
		audit.record({ label: `${scenario}:state`, status: 'ok', note: JSON.stringify(state) });
		await audit.screenshot(page, `${evidence}-opened`);

		await audit.time(`${scenario}:show-full-headers`, async () => {
			await page.locator('#V-MailMessageView .messageItemHeader .infoParent').first().click();
			await page.locator('#V-MailMessageView .informationFull').waitFor({ state: 'visible', timeout: 15000 });
		});
		await audit.screenshot(page, `${evidence}-full-headers`);

		await audit.time(`${scenario}:open-actions-menu`, async () => {
			await page.locator('#more-view-dropdown-id').click();
			const menu = page.locator('#V-MailMessageView menu[aria-labelledby="more-view-dropdown-id"]');
			await menu.waitFor({ state: 'visible', timeout: 15000 });
			const labels = (await menu.locator('a').allTextContents()).map(value => value.trim());
			for (const label of ['Reply', 'Forward', 'Move To']) {
				if (!labels.includes(label)) {
					throw new Error(`Message actions menu is missing ${label}: ${JSON.stringify(labels)}`);
				}
			}
		});
		await audit.screenshot(page, `${evidence}-actions-menu`);

		await audit.time(`${scenario}:close`, async () => {
			await page.locator('#V-MailMessageView .top-toolbar .buttonClose').click();
			await page.waitForFunction(() => !ko.dataFor(document.querySelector('#V-MailMessageView'))?.message?.(), null, { timeout: 15000 });
		});
		await audit.screenshot(page, `${evidence}-closed`);
	} catch (error) {
		await audit.screenshot(page, `${evidence}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

const auditCalendarInvite = async (browser, account, audit) => {
	const scenario = `calendar-${account.label}`;
	const evidence = scenario.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	try {
		await login(page, account, audit);
		const subject = await calendarFixtureSubject(page, account.domain);
		await audit.time(`${scenario}:open`, () => openMessageBySubject(page, subject));
		const state = await audit.time(`${scenario}:inspect`, () => page.locator('#V-MailMessageView').evaluate(async element => {
			const view = ko.dataFor(element);
			const message = view?.message?.();
			const attachment = (message?.attachments?.() || []).find(item => 'text/calendar' === item?.mimeType);
			if (!attachment) {
				return { subject: message?.subject?.() || '', attachment: null, calendarAddControls: 0 };
			}
			const response = await fetch(attachment.linkDownload());
			const raw = await response.text();
			return {
				subject: message?.subject?.() || '',
				attachment: {
					fileName: attachment.fileName,
					mimeType: attachment.mimeType,
					fileType: attachment.fileType,
					rawHasCalendar: raw.includes('BEGIN:VCALENDAR'),
					rawHasEvent: raw.includes('BEGIN:VEVENT'),
					rawHasUid: /^UID:/m.test(raw)
				},
				calendarAddControls: element.querySelectorAll('[data-calendar-action], .calendarAddEvent').length
			};
		}));
		const issues = [
			state.subject !== subject && `opened subject changed to ${state.subject}`,
			!state.attachment && 'calendar attachment was not exposed',
			state.attachment?.fileName?.endsWith('.ics') !== true && 'calendar attachment filename is not .ics',
			'text/calendar' !== state.attachment?.mimeType && 'calendar attachment MIME type is not text/calendar',
			'calendar' !== state.attachment?.fileType && 'calendar attachment was not typed as calendar',
			!state.attachment?.rawHasCalendar && 'calendar attachment did not contain VCALENDAR',
			!state.attachment?.rawHasEvent && 'calendar attachment did not contain VEVENT',
			!state.attachment?.rawHasUid && 'calendar attachment did not contain UID'
		].filter(Boolean);
		audit.record({
			label: `${scenario}:state`,
			status: issues.length ? 'error' : 'ok',
			note: JSON.stringify(state),
			error: issues.length ? `Calendar invitation contract failed: ${issues.join(', ')}.` : undefined
		});
		audit.record({
			label: `${scenario}:no-automatic-write`,
			status: 'observed',
			note: `Calendar add controls currently visible: ${state.calendarAddControls}. Opening an invitation must remain side-effect free.`
		});
		await audit.screenshot(page, `${evidence}-opened`);
	} catch (error) {
		await audit.screenshot(page, `${evidence}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

const auditListNavigation = async (browser, account, audit) => {
	const scenario = `list-navigation-${account.label}`;
	const evidence = scenario.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	try {
		await login(page, account, audit);
		const [subject] = await fixtureSubjects(page, 1);
		const initial = await messageListState(page);
		if (initial.pageCount < 2) {
			throw new Error(`Expected at least two mailbox pages after seeding; got ${JSON.stringify(initial)}`);
		}

		await audit.time(`${scenario}:next-page`, async () => {
			await page.locator('#V-MailMessageList .e-paginator a').filter({ hasText: '2' }).first().click();
			await page.waitForFunction(() => ko.dataFor(document.querySelector('#V-MailMessageList'))?.messageList?.page?.() === 2, null, { timeout: 45000 });
		});
		await audit.screenshot(page, `${evidence}-page-two`);
		await audit.time(`${scenario}:first-page`, async () => {
			await page.locator('#V-MailMessageList .e-paginator a').filter({ hasText: '1' }).first().click();
			await page.waitForFunction(() => ko.dataFor(document.querySelector('#V-MailMessageList'))?.messageList?.page?.() === 1, null, { timeout: 45000 });
			await waitForSubject(page, subject, true);
		});

		await audit.time(`${scenario}:sort-subject`, async () => {
			await page.locator('#sort-list-dropdown-id').click();
			const menu = page.locator('#V-MailMessageList menu[aria-labelledby="sort-list-dropdown-id"]');
			await menu.waitFor({ state: 'visible', timeout: 15000 });
			await menu.locator('li[data-sort="SUBJECT"] a').click();
			await page.waitForFunction(() => {
				const view = ko.dataFor(document.querySelector('#V-MailMessageList'));
				return view?.sortText?.().includes('𝐒') && !view?.messageList?.isLoading?.();
			}, null, { timeout: 45000 });
		});
		await audit.screenshot(page, `${evidence}-subject-sort`);
		await audit.time(`${scenario}:restore-date-sort`, async () => {
			await page.locator('#sort-list-dropdown-id').click();
			const menu = page.locator('#V-MailMessageList menu[aria-labelledby="sort-list-dropdown-id"]');
			await menu.waitFor({ state: 'visible', timeout: 15000 });
			await menu.locator('li[data-sort=""] a').click();
			await page.waitForFunction(() => {
				const view = ko.dataFor(document.querySelector('#V-MailMessageList'));
				return view?.sortText?.().startsWith('📅') && !view?.messageList?.isLoading?.();
			}, null, { timeout: 45000 });
		});

		await audit.time(`${scenario}:open-advanced-search`, async () => {
			await page.locator('.buttonMoreSearch').click();
			const popup = page.locator('#V-PopupsAdvancedSearch');
			await popup.waitFor({ state: 'visible', timeout: 15000 });
			await waitForSettledDialog(page, popup);
			await popup.locator('form input[type="text"]').nth(2).fill(searchQueryForFixture(subject));
			await audit.screenshot(page, `${evidence}-advanced-search`);
			await popup.locator('button.buttonAdvSearch').click();
			await popup.waitFor({ state: 'hidden', timeout: 15000 });
			await waitForSubject(page, subject, true);
		});
		await audit.screenshot(page, `${evidence}-advanced-results`);
		await audit.time(`${scenario}:clear-advanced-search`, async () => {
			await page.locator('.closeSearch').click();
			await page.waitForFunction(() => {
				const description = document.querySelector('.listSearchDesc');
				return !description || 'none' === getComputedStyle(description).display;
			}, null, { timeout: 15000 });
		});
	} catch (error) {
		await audit.screenshot(page, `${evidence}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

const auditSession = async (browser, account, audit) => {
	const scenario = `session-${account.label}`;
	const evidence = scenario.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	try {
		await login(page, account, audit);
		const menu = await audit.time(`${scenario}:open-menu`, () => ensureAccountMenuOpen(page));
		await audit.screenshot(page, `${evidence}-account-menu`);
		await audit.time(`${scenario}:logout`, async () => {
			await menu.locator('a[data-i18n="GLOBAL/LOGOUT"]').click();
			await page.locator('input[name=Email]').waitFor({ state: 'visible', timeout: 45000 });
			await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') !== true, null, { timeout: 15000 });
		});
		await audit.screenshot(page, `${evidence}-logged-out`);
		await audit.time(`${scenario}:relogin`, async () => {
			await page.locator('input[name=Email]').fill(account.email);
			await page.locator('input[name=Password]').fill(account.password);
			await page.locator('.buttonLogin').click();
			await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true, null, { timeout: 90000 });
			await waitForMailboxList(page);
		});
		await audit.screenshot(page, `${evidence}-relogged-in`);
	} catch (error) {
		await audit.screenshot(page, `${evidence}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

const auditDraftLifecycle = async (browser, account, audit) => {
	const scenario = `drafts-${account.label}`;
	const evidence = scenario.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
	const recordStart = audit.records.length;
	const subject = `Snappy audit draft ${account.domain} ${Date.now()}`;
	const body = `Draft lifecycle body for ${account.email} ${Date.now()}`;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	try {
		await login(page, account, audit);
		const compose = await openCompose(page, account, audit, `${scenario}:compose`);
		await compose.locator('input[name="subject"]').fill(subject);
		await compose.evaluate((element, value) => ko.dataFor(element).editor(editor => editor.setPlain(value)), body);
		await audit.time(`${scenario}:save`, async () => {
			await compose.locator('.button-save').click();
			await page.waitForFunction(element => {
				const view = ko.dataFor(element);
				return !!view?.draftUid?.() && !view?.saving?.() && !view?.savedError?.();
			}, await compose.elementHandle(), { timeout: 90000 });
		});
		const state = await compose.evaluate(element => {
			const view = ko.dataFor(element);
			return {
				draftsFolder: view?.draftsFolder?.() || '',
				draftUid: view?.draftUid?.() || 0,
				savedError: !!view?.savedError?.(),
				savedErrorDesc: view?.savedErrorDesc?.() || ''
			};
		});
		if (!state.draftsFolder || !state.draftUid || state.savedError) {
			throw new Error(`Draft save did not produce a valid draft state: ${JSON.stringify(state)}`);
		}
		audit.record({ label: `${scenario}:saved-state`, status: 'ok', note: JSON.stringify(state) });
		await audit.screenshot(page, `${evidence}-saved`);

		await audit.time(`${scenario}:delete`, async () => {
			await compose.locator('.button-delete').click();
			const ask = page.locator('#V-PopupsAsk');
			await ask.waitFor({ state: 'visible', timeout: 15000 });
			await waitForSettledDialog(page, ask);
			await audit.screenshot(page, `${evidence}-delete-confirmation`);
			await ask.locator('.buttonYes').click();
			await compose.waitFor({ state: 'hidden', timeout: 30000 });
		});
		await audit.screenshot(page, `${evidence}-deleted`);
	} catch (error) {
		await audit.screenshot(page, `${evidence}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

const ensureAccountMenuOpen = async page => {
	const menu = page.locator('#V-SystemDropDown menu');
	if (!await menu.isVisible().catch(() => false)) {
		await page.locator('#top-system-dropdown-id').click();
		await menu.waitFor({ state: 'visible', timeout: 15000 });
	}
	return menu;
};

const addAndSwitchAccount = async (browser, primaryAccount, additionalAccount, audit) => {
	const scenario = `account-switch-${primaryAccount.label}-to-${additionalAccount.label}`;
	const evidence = scenario.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	try {
		await login(page, primaryAccount, audit);
		await audit.time(`${scenario}:open-menu`, () => ensureAccountMenuOpen(page));
		const accountLink = page.locator(`#V-SystemDropDown .email-title[title="${additionalAccount.email}"]`);
		if (!await accountLink.count()) {
			await audit.time(`${scenario}:open-add-account`, async () => {
				const menu = await ensureAccountMenuOpen(page);
				await menu.getByText('Add Account', { exact: true }).click();
				const popup = page.locator('#V-PopupsAccount');
				await popup.waitFor({ state: 'visible', timeout: 15000 });
				await waitForSettledDialog(page, popup);
			});
			const popup = page.locator('#V-PopupsAccount');
			await popup.locator('input[name=email]').fill(additionalAccount.email);
			await popup.locator('input[name=password]').fill(additionalAccount.password);
			await popup.locator('input[name=name]').fill(`Snappy Audit ${additionalAccount.label}`);
			await audit.screenshot(page, `${evidence}-add-account`);
			await audit.time(`${scenario}:add-account`, async () => {
				await popup.locator('button.buttonAddAccount').click();
				const outcome = await page.waitForFunction(element => {
					const view = ko.dataFor(element);
					if (view?.submitError?.()) {
						return { status: 'error', detail: view.submitErrorAdditional?.() || view.submitError?.() };
					}
					return view?.modalVisible?.() ? null : { status: 'closed' };
				}, await popup.elementHandle(), { timeout: 60000 });
				const result = await outcome.jsonValue();
				if ('error' === result.status) {
					throw new Error(result.detail);
				}
				await ensureAccountMenuOpen(page);
				await accountLink.waitFor({ state: 'visible', timeout: 45000 });
			});
		}
		await audit.time(`${scenario}:reopen-menu`, () => ensureAccountMenuOpen(page));
		await accountLink.waitFor({ state: 'visible', timeout: 45000 });
		await audit.screenshot(page, `${evidence}-ready-to-switch`);
		await audit.time(`${scenario}:switch`, async () => {
			await accountLink.click();
			await page.waitForFunction(email =>
				window.rl?.settings?.get?.('Auth') === true && document.title.includes(email),
			additionalAccount.email,
			{ timeout: 60000 }
			);
			await waitForMailboxList(page);
		});
		await completeIdentityOnboarding(page, additionalAccount, audit, 5000);
		await page.locator('#V-PopupsIdentity').waitFor({ state: 'hidden', timeout: 15000 });
		await inspectState(page, scenario, audit);
		await audit.screenshot(page, `${evidence}-switched`);
	} catch (error) {
		await audit.screenshot(page, `${evidence}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

const activeDialogIds = page => page.evaluate(() =>
	[...document.querySelectorAll('dialog')]
		.filter(element => element.open && !element.hidden && ko.dataFor(element)?.modalVisible?.())
		.map(element => element.id)
);

const bootstrapFreshAccount = async (browser, account, audit) => {
	const scenario = `bootstrap-${account.label}`;
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	const browserDialogs = [];
	page.on('dialog', async dialog => {
		browserDialogs.push({ type: dialog.type(), message: dialog.message() });
		await dialog.dismiss();
	});
	try {
		await login(page, account, audit);
		await completeIdentityOnboarding(page, account, audit, 5000);
		await page.evaluate(() => location.hash = '#/settings/security');
		await audit.time(`${scenario}:security-ready`, () => page.waitForFunction(() => {
			const element = document.querySelector('#V-Settings-Security');
			const view = element && ko.dataFor(element);
			return view?.encryptionReady?.() && 1 === view?.gnupgPrivateCount?.();
		}, null, { timeout: 60000 }));
		const state = await page.locator('#V-Settings-Security').evaluate(element => {
			const view = ko.dataFor(element);
			return {
				privateKeyCount: view?.gnupgPrivateCount?.(),
				ready: !!view?.encryptionReady?.(),
				summary: view?.encryptionSummary?.(),
				status: view?.encryptionStatus?.()
			};
		});
		const activeDialogs = await activeDialogIds(page);
		audit.record({ label: `${scenario}:state`, status: 'ok', note: JSON.stringify({ state, activeDialogs, browserDialogs }) });
		if (1 !== state.privateKeyCount || !state.ready || 'Ready' !== state.status || activeDialogs.length || browserDialogs.length) {
			throw new Error(`Expected one ready server key with no blocking password dialog; got ${JSON.stringify({ state, activeDialogs, browserDialogs })}`);
		}
		await audit.screenshot(page, `${scenario}-security-ready`);
	} catch (error) {
		await audit.screenshot(page, `${scenario}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

const auditMobileAccount = async (browser, account, audit) => {
	const scenario = `mobile-${account.label}`;
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	try {
		await login(page, account, audit);
		const layout = await page.evaluate(() => {
			const compose = [...document.querySelectorAll('#V-MailMessageList .buttonCompose, #rl-left .buttonCompose')]
				.find(element => {
					const box = element.getBoundingClientRect();
					const style = getComputedStyle(element);
					return 'none' !== style.display && 'hidden' !== style.visibility && box.width > 0 && box.height > 0;
				});
			const box = compose?.getBoundingClientRect();
			return {
				viewportWidth: window.innerWidth,
				documentWidth: document.documentElement.scrollWidth,
				composeVisible: !!box && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight
			};
		});
		audit.record({ label: `${scenario}:layout`, status: 'ok', note: JSON.stringify(layout) });
		if (layout.documentWidth > layout.viewportWidth + 2 || !layout.composeVisible) {
			throw new Error(`Mobile layout is not usable: ${JSON.stringify(layout)}`);
		}
		await audit.screenshot(page, `${scenario}-mailbox`);
		const compose = await openCompose(page, account, audit, `${scenario}:compose`);
		await audit.screenshot(page, `${scenario}-compose`);
		await closeCompose(page, compose);
	} catch (error) {
		await audit.screenshot(page, `${scenario}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

const auditKeyboardAccount = async (browser, account, audit) => {
	const scenario = `keyboard-${account.label}`;
	const recordStart = audit.records.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	try {
		await login(page, account, audit);
		await page.locator('#V-MailMessageView').click();
		await page.keyboard.press('Shift+/');
		const help = page.locator('#V-PopupsKeyboardShortcutsHelp');
		await help.waitFor({ state: 'visible', timeout: 15000 });
		await waitForSettledDialog(page, help);
		const shortcutCount = await help.locator('.keyboard-shortcuts-generated > label').count();
		if (shortcutCount < 6) {
			throw new Error(`Expected at least six keyboard shortcut entries, found ${shortcutCount}.`);
		}
		audit.record({ label: `${scenario}:help-state`, status: 'ok', note: `${shortcutCount} shortcut entries` });
		await audit.screenshot(page, `${scenario}-help`);
		await help.locator('header > .close').click();
		await help.waitFor({ state: 'hidden', timeout: 15000 });
		const compose = await openCompose(page, account, audit, `${scenario}:compose`);
		const bcc = compose.locator('.bcc-row');
		const cc = compose.locator('.cc-row');
		if (await bcc.isVisible() || await cc.isVisible()) {
			throw new Error('Compose opened with optional recipient rows already visible.');
		}
		await page.keyboard.press('Alt+B');
		await bcc.waitFor({ state: 'visible', timeout: 10000 });
		await page.keyboard.press('Alt+C');
		await cc.waitFor({ state: 'visible', timeout: 10000 });
		await audit.screenshot(page, `${scenario}-compose-shortcuts`);
		await closeCompose(page, compose);
	} catch (error) {
		await audit.screenshot(page, `${scenario}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

const inspectSentCopy = async (page, senderAccount, recipientAccount, subject, body, audit) => {
	await openFolder(page, 'Sent');
	await audit.time(`${senderAccount.label}:open-sent-copy-${recipientAccount.label}`, async () => {
		await page.getByText(subject, { exact: true }).first().click({ force: true, timeout: 60000 });
		await page.waitForFunction(expected => document.querySelector('#V-MailMessageView')?.innerText.includes(expected), body, { timeout: 60000 });
	});
	await audit.time(`${senderAccount.label}:sent-signature-settle-${recipientAccount.label}`, () =>
		page.waitForFunction(() => {
			const signed = ko.dataFor(document.querySelector('#V-MailMessageView'))?.message?.()?.pgpSigned?.();
			return signed && 'boolean' === typeof signed.success;
		}, null, { timeout: 60000 })
	).catch(() => null);
	const state = await page.locator('#V-MailMessageView').evaluate(element => {
		const message = ko.dataFor(element)?.message?.();
		const text = element.innerText;
		const signed = message?.pgpSigned?.();
		return {
			folder: message?.folder || '',
			pgpDecrypted: !!message?.pgpDecrypted?.(),
			pgpSignedSuccess: signed?.success,
			pgpSignature: signed && {
				detected: !!signed.detected,
				checked: !!signed.checked,
				checking: !!signed.checking,
				success: signed.success
			},
			hasArmor: text.includes('BEGIN PGP MESSAGE'),
			hasCouldNotDecrypt: text.includes('could not be decrypted'),
			hasRemoteDeliveryClaim: /recipient (?:message )?(?:decrypted|verified)|delivered to recipient/i.test(text)
		};
	});
	const issues = [
		!state.pgpDecrypted && 'sent copy was not marked locally decrypted',
		state.hasArmor && 'sent copy still shows encrypted armor',
		state.hasCouldNotDecrypt && 'sent copy shows decrypt failure text',
		state.hasRemoteDeliveryClaim && 'sent copy claimed recipient delivery state'
	].filter(Boolean);
	audit.record({
		label: `${senderAccount.label}:sent-copy-state-${recipientAccount.label}`,
		status: issues.length ? 'error' : 'ok',
		note: JSON.stringify(state),
		error: issues.length ? `Expected a truthful local Sent copy: ${issues.join(', ')}.` : undefined
	});
	await audit.screenshot(page, `${senderAccount.label}-sent-copy-to-${recipientAccount.label}`);
};

const sendInternalMessage = async (browser, pair, audit, assertPreparedPlan = false) => {
	const [senderAccount, recipientAccount] = pair;
	const subject = `Snappy audit ${senderAccount.domain} ${Date.now()}`;
	const body = `Snappy audit body ${senderAccount.email} to ${recipientAccount.email} ${Date.now()}`;
	const senderContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const sender = await senderContext.newPage();
	let sent = false;
	let received = false;
	try {
		await login(sender, senderAccount, audit);
		const compose = await openCompose(sender, senderAccount, audit, `${senderAccount.label}:send-internal`);
		await compose.locator('.emailaddresses input').first().fill(recipientAccount.email);
		await sender.keyboard.press('Enter');
		await compose.locator('input[name="subject"]').fill(subject);
		await compose.evaluate((element, value) => ko.dataFor(element).editor(editor => editor.setPlain(value)), body);
		await audit.screenshot(sender, `${senderAccount.label}-compose-to-${recipientAccount.label}`);
		await audit.time(`${senderAccount.label}:wait-crypto-state-${recipientAccount.label}`, async () =>
			sender.waitForFunction(element => {
				const vm = ko.dataFor(element);
				return !!(vm?.doEncrypt?.() || vm?.internalGnuPGState?.().ready || vm?.encryptOptionsText?.()?.includes('GnuPG'));
			}, await compose.elementHandle(), { timeout: 45000 }).catch(error => {
				audit.record({ label: `${senderAccount.label}:crypto-state-wait-note`, status: 'error', error: error.message });
			})
		);
		const composeState = await compose.evaluate(element => {
			const vm = ko.dataFor(element);
			const state = vm?.internalGnuPGState?.();
			return {
				doSign: !!vm?.doSign?.(),
				doEncrypt: !!vm?.doEncrypt?.(),
				internalReady: !!state?.ready,
				internalRecipients: state?.recipients || [],
				internalNotice: element.querySelector('.organization-encryption-status')?.innerText.trim() || '',
				signOptions: vm?.signOptionsText?.(),
				encryptOptions: vm?.encryptOptionsText?.()
			};
		});
		const crossDomainMisclassified = assertPreparedPlan && (composeState.internalReady || composeState.internalNotice);
		audit.record({
			label: `${senderAccount.label}:compose-crypto-state`,
			status: crossDomainMisclassified ? 'error' : 'ok',
			note: JSON.stringify(composeState),
			error: crossDomainMisclassified ? 'Cross-domain recipient was incorrectly classified as an organization recipient.' : undefined
		});
		if (assertPreparedPlan) {
			const requestPreview = await audit.time(`${senderAccount.label}:prepare-encrypted-${recipientAccount.label}`, () =>
				compose.evaluate(async element => {
					const vm = ko.dataFor(element);
					const params = await vm.getMessageRequestParams('', false);
					return {
						signFingerprint: params.signFingerprint || '',
						hasSignPassphrase: !!params.signPassphrase,
						encryptFingerprints: JSON.parse(params.encryptFingerprints || '[]'),
						encrypted: !!params.encrypted,
						signed: !!params.signed
					};
				})
			);
			audit.record({ label: `${senderAccount.label}:prepared-encryption-plan-${recipientAccount.label}`, status: 'ok', note: JSON.stringify(requestPreview) });
			if (!requestPreview.signFingerprint || !requestPreview.hasSignPassphrase || 2 !== requestPreview.encryptFingerprints.length) {
				throw new Error(`Prepared encryption plan is incomplete: ${JSON.stringify(requestPreview)}`);
			}
		}
		await audit.time(`${senderAccount.label}:send-to-${recipientAccount.label}`, async () => {
			await compose.locator('header > a.btn').first().click();
			await sender.waitForFunction(() => {
				const element = document.querySelector('#V-PopupsCompose');
				const vm = element && ko.dataFor(element);
				return !element || element.hidden || !vm?.modalVisible?.() || vm.sendError?.();
			}, null, { timeout: 60000 });
			const sendState = await compose.evaluate(element => {
				const vm = ko.dataFor(element);
				return {
					visible: !!vm?.modalVisible?.(),
					sending: !!vm?.sending?.(),
					sendError: !!vm?.sendError?.(),
					sendErrorDesc: vm?.sendErrorDesc?.() || ''
				};
			});
			audit.record({
				label: `${senderAccount.label}:send-state-${recipientAccount.label}`,
				status: 'observed',
				note: JSON.stringify(sendState)
			});
			if (sendState.sendError || sendState.visible) {
				throw new Error(sendState.sendErrorDesc || 'Compose remained open after Send.');
			}
		});
		sent = true;
		await inspectSentCopy(sender, senderAccount, recipientAccount, subject, body, audit);
	} catch (error) {
		await audit.screenshot(sender, `${senderAccount.label}-send-error`);
		audit.record({ label: `${senderAccount.label}:send-observed-failure`, status: 'observed', note: error.message });
	} finally {
		await senderContext.close();
	}
	if (!sent) {
			audit.record({
				label: `${recipientAccount.label}:receive-skipped-${senderAccount.label}`,
				status: 'skipped',
				note: 'Sender did not complete the send workflow.'
			});
			return { sent, received, subject, body };
		}

	const recipientContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const recipient = await recipientContext.newPage();
	const decryptResponses = [];
	recipient.on('response', response => {
		const request = response.request();
		if (!request.postData()?.includes('GnupgDecrypt')) {
			return;
		}
		response.json().then(payload => {
			const data = payload?.Result?.data || '';
			decryptResponses.push({
				status: response.status(),
				hasMimeHeaders: /^[-A-Za-z]+:/m.test(data),
				hasMultipartSigned: /multipart\/signed/i.test(data),
				hasPgpSignaturePart: /application\/pgp-signature/i.test(data),
				signatureCount: Array.isArray(payload?.Result?.signatures) ? payload.Result.signatures.length : 0
			});
		}).catch(() => null);
	});
	const recipientRecordStart = audit.records.length;
	try {
		await login(recipient, recipientAccount, audit);
		await audit.time(`${recipientAccount.label}:open-received-${senderAccount.label}`, async () => {
			await recipient.getByText(subject, { exact: true }).first().click({ force: true, timeout: 60000 });
			await recipient.waitForFunction(expected => document.body.innerText.includes(expected), body, { timeout: 60000 });
		});
		audit.record({
			label: `${recipientAccount.label}:decrypt-response-${senderAccount.label}`,
			status: 'observed',
			note: JSON.stringify(decryptResponses)
		});
		await audit.time(`${recipientAccount.label}:signature-settle-${senderAccount.label}`, () =>
			recipient.waitForFunction(() => {
				const signed = ko.dataFor(document.querySelector('#V-MailMessageView'))?.message?.()?.pgpSigned?.();
				return signed && 'boolean' === typeof signed.success;
			}, null, { timeout: 60000 })
		).catch(() => null);
		await audit.screenshot(recipient, `${recipientAccount.label}-received-from-${senderAccount.label}`);
		const messageState = await recipient.locator('#V-MailMessageView').evaluate(element => {
			const message = ko.dataFor(element)?.message?.();
			const text = element.innerText;
			const signed = message?.pgpSigned?.();
			return {
				pgpDecrypted: !!message?.pgpDecrypted?.(),
				pgpSignedSuccess: signed?.success,
				pgpSignature: signed && {
					detected: !!signed.detected,
					checked: !!signed.checked,
					checking: !!signed.checking,
					success: signed.success
				},
				hasArmor: text.includes('BEGIN PGP MESSAGE'),
				hasCouldNotDecrypt: text.includes('could not be decrypted'),
				hasSignatureVerified: text.includes('Signature verified automatically')
			};
		});
		const issues = [
			!messageState.pgpDecrypted && 'message was not marked decrypted',
			messageState.hasArmor && 'encrypted armor remains visible',
			messageState.hasCouldNotDecrypt && 'decrypt failure text is visible',
			true !== messageState.pgpSignedSuccess && 'signature verification did not succeed',
			!messageState.hasSignatureVerified && 'verified status is not visible'
		].filter(Boolean);
			audit.record({
				label: `${recipientAccount.label}:received-message-state`,
				status: issues.length ? 'error' : 'ok',
				note: JSON.stringify(messageState),
				error: issues.length ? `Expected decrypted and verified message: ${issues.join(', ')}.` : undefined
			});
			received = !issues.length;
	} catch (error) {
		await audit.screenshot(recipient, `${recipientAccount.label}-receive-error`);
		recordFailure(audit, recipientRecordStart, { label: `${recipientAccount.label}:receive-error`, error: error.message });
	} finally {
		await recipientContext.close();
	}
	return { sent, received, subject, body };
};

const readLifecycleState = () => {
	if (!fs.existsSync(lifecycleStateFile)) {
		return {};
	}
	return JSON.parse(fs.readFileSync(lifecycleStateFile, 'utf8'));
};

const writeLifecycleState = state => {
	mkdir(path.dirname(lifecycleStateFile));
	fs.writeFileSync(lifecycleStateFile, JSON.stringify(state, null, 2));
};

const prepareRotationAccount = async (browser, account, audit) => {
	const scenario = `lifecycle-prepare-${account.label}`;
	const recordStart = audit.records.length;
	try {
		const result = await sendInternalMessage(browser, [account, account], audit);
		if (!result?.sent || !result.received) {
			throw new Error(`Encrypted pre-rotation message did not complete: ${JSON.stringify(result || {})}`);
		}
		const state = readLifecycleState();
		state[account.label] = {
			email: account.email,
			subject: result.subject,
			body: result.body,
			preparedAt: new Date().toISOString()
		};
		writeLifecycleState(state);
		audit.record({ label: `${scenario}:message-state`, status: 'ok', note: JSON.stringify({ subject: result.subject, stateFile: rel(lifecycleStateFile) }) });
	} catch (error) {
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	}
};

const verifyRotationAccount = async (browser, account, audit) => {
	const scenario = `lifecycle-verify-${account.label}`;
	const recordStart = audit.records.length;
	const message = readLifecycleState()[account.label];
	const rotatedAccount = { ...account, password: account.rotatedPassword };
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
	const page = await context.newPage();
	const browserDialogs = [];
	page.on('dialog', async dialog => {
		browserDialogs.push({ type: dialog.type(), message: dialog.message() });
		await dialog.dismiss();
	});
	try {
		if (!message?.subject || !message?.body) {
			throw new Error(`Missing pre-rotation message state for ${account.label}. Run lifecycle prepare first.`);
		}
		await login(page, rotatedAccount, audit);
		await completeIdentityOnboarding(page, rotatedAccount, audit, 5000);
		await audit.time(`${scenario}:open-pre-rotation-message`, async () => {
			await page.getByText(message.subject, { exact: true }).first().click({ force: true, timeout: 60000 });
			await page.waitForFunction(expected => document.querySelector('#V-MailMessageView')?.innerText.includes(expected), message.body, { timeout: 60000 });
		});
		await audit.time(`${scenario}:signature-settle`, () => page.waitForFunction(() => {
			const signed = ko.dataFor(document.querySelector('#V-MailMessageView'))?.message?.()?.pgpSigned?.();
			return signed && 'boolean' === typeof signed.success;
		}, null, { timeout: 60000 }));
		const messageState = await page.locator('#V-MailMessageView').evaluate(element => {
			const item = ko.dataFor(element)?.message?.();
			const text = element.innerText;
			return {
				pgpDecrypted: !!item?.pgpDecrypted?.(),
				pgpSignedSuccess: item?.pgpSigned?.()?.success,
				hasArmor: text.includes('BEGIN PGP MESSAGE'),
				hasCouldNotDecrypt: text.includes('could not be decrypted'),
				hasSignatureVerified: text.includes('Signature verified automatically')
			};
		});
		await page.evaluate(() => location.hash = '#/settings/security');
		await audit.time(`${scenario}:security-ready`, () => page.waitForFunction(() => {
			const element = document.querySelector('#V-Settings-Security');
			const view = element && ko.dataFor(element);
			return view?.encryptionReady?.() && 1 === view?.gnupgPrivateCount?.();
		}, null, { timeout: 60000 }));
		const securityState = await page.locator('#V-Settings-Security').evaluate(element => {
			const view = ko.dataFor(element);
			return { privateKeyCount: view?.gnupgPrivateCount?.(), ready: !!view?.encryptionReady?.(), status: view?.encryptionStatus?.() };
		});
		const activeDialogs = await activeDialogIds(page);
		const issues = [
			!messageState.pgpDecrypted && 'old message was not decrypted',
			true !== messageState.pgpSignedSuccess && 'old message signature did not verify',
			messageState.hasArmor && 'old message still shows encrypted armor',
			messageState.hasCouldNotDecrypt && 'old message shows decrypt failure text',
			!messageState.hasSignatureVerified && 'old message has no verified signature status',
			1 !== securityState.privateKeyCount && 'current private-key count is not one',
			!securityState.ready && 'security summary is not ready',
			activeDialogs.length ? `blocking dialogs remain: ${activeDialogs.join(', ')}` : false,
			browserDialogs.length ? 'browser password dialog appeared' : false
		].filter(Boolean);
		audit.record({
			label: `${scenario}:state`,
			status: issues.length ? 'error' : 'ok',
			note: JSON.stringify({ messageState, securityState, activeDialogs, browserDialogs }),
			error: issues.length ? `Password rotation did not preserve old-mail access: ${issues.join(', ')}.` : undefined
		});
		await audit.screenshot(page, `${scenario}-security-and-message`);
	} catch (error) {
		await audit.screenshot(page, `${scenario}-error`);
		recordFailure(audit, recordStart, { label: `${scenario}:error`, error: error.message });
	} finally {
		await context.close();
	}
};

test('audit public BoomPay and nixc SnappyMail flows', async ({ browser }) => {
	test.setTimeout(30 * 60 * 1000);
	const audit = new Audit();
	try {
		if (wantsCase('route')) {
			for (const account of [accounts[0], accounts[2]].filter(wantsAccount)) {
				await probePublicRoute(account, audit, 'public-route-h2', [], 3);
				await probePublicRoute(account, audit, 'public-route-http1', ['--disable-http2', '--disable-quic'], 2);
			}
		}

		if (wantsCase('baseline')) {
			for (const account of accounts) {
				const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
				const page = await context.newPage();
				const recordStart = audit.records.length;
				try {
					await login(page, account, audit);
					await inspectState(page, account.label, audit);
					const compose = await openCompose(page, account, audit);
					await audit.screenshot(page, `${account.label}-compose-open`);
					await closeCompose(page, compose);
					await page.evaluate(() => location.hash = '#/settings/security');
					await audit.time(`${account.label}:settings-security`, () => page.locator('.encryption-summary').waitFor({ state: 'visible', timeout: 45000 }));
					await audit.screenshot(page, `${account.label}-settings-security`);
				} catch (error) {
					await audit.screenshot(page, `${account.label}-baseline-error`);
					recordFailure(audit, recordStart, { label: `${account.label}:baseline-error`, error: error.message });
				} finally {
					await context.close();
				}
			}
		}

		if (wantsCase('selection')) {
			await selectAllInCurrentView(browser, accounts[1], audit, 'h2-boompay-b');
			await selectAllInCurrentView(browser, accounts[3], audit, 'h2-nixc-b');
			const http1Browser = await chromium.launch({
				args: ['--disable-http2', '--disable-quic'],
				...(chromiumExecutable ? { executablePath: chromiumExecutable } : {})
			});
			try {
				await selectAllInCurrentView(http1Browser, accounts[1], audit, 'http1-boompay-b');
				await selectAllInCurrentView(http1Browser, accounts[3], audit, 'http1-nixc-b');
				if (await ensureSpamMessages(http1Browser, accounts[1], audit, 'http1-boompay-b')) {
					await selectAllInCurrentView(http1Browser, accounts[1], audit, 'http1-boompay-b-spam', 'Spam');
				} else {
					audit.record({ label: 'http1-boompay-b-spam:selection-skipped', status: 'skipped', note: 'Spam fixture was not available.' });
				}
				if (await ensureSpamMessages(http1Browser, accounts[3], audit, 'http1-nixc-b')) {
					await selectAllInCurrentView(http1Browser, accounts[3], audit, 'http1-nixc-b-spam', 'Spam');
				} else {
					audit.record({ label: 'http1-nixc-b-spam:selection-skipped', status: 'skipped', note: 'Spam fixture was not available.' });
				}
			} finally {
				await http1Browser.close();
			}
		}
		if (wantsCase('mailbox-actions')) {
			for (const account of [accounts[1], accounts[3]].filter(wantsAccount)) {
				await auditMailboxActions(browser, account, audit);
			}
		}
		if (wantsCase('message-view')) {
			for (const account of [accounts[1], accounts[3]].filter(wantsAccount)) {
				await auditMessageView(browser, account, audit);
			}
		}
		if (wantsCase('calendar')) {
			for (const account of [accounts[1], accounts[3]].filter(wantsAccount)) {
				await auditCalendarInvite(browser, account, audit);
			}
		}
		if (wantsCase('list-navigation')) {
			for (const account of [accounts[1], accounts[3]].filter(wantsAccount)) {
				await auditListNavigation(browser, account, audit);
			}
		}
		if (wantsCase('session')) {
			for (const account of [accounts[1], accounts[3]].filter(wantsAccount)) {
				await auditSession(browser, account, audit);
			}
		}
		if (wantsCase('drafts')) {
			for (const account of [accounts[1], accounts[3]].filter(wantsAccount)) {
				await auditDraftLifecycle(browser, account, audit);
			}
		}

		if (wantsCase('crypto')) {
			await sendInternalMessage(browser, [accounts[0], accounts[1]], audit);
			await sendInternalMessage(browser, [accounts[2], accounts[3]], audit);
		}
		if (wantsCase('cross-domain')) {
			await sendInternalMessage(browser, [freshAccounts[0], freshAccounts[1]], audit, true);
			await sendInternalMessage(browser, [freshAccounts[1], freshAccounts[0]], audit, true);
		}
		if (wantsCase('accounts')) {
			await addAndSwitchAccount(browser, accounts[0], accounts[1], audit);
			await addAndSwitchAccount(browser, accounts[2], accounts[3], audit);
		}
		if (wantsCase('bootstrap')) {
			for (const account of freshAccounts) {
				await bootstrapFreshAccount(browser, account, audit);
			}
		}
		if (wantsCase('mobile')) {
			await auditMobileAccount(browser, accounts[1], audit);
			await auditMobileAccount(browser, accounts[3], audit);
		}
		if (wantsCase('keyboard')) {
			await auditKeyboardAccount(browser, accounts[1], audit);
			await auditKeyboardAccount(browser, accounts[3], audit);
		}
		if (wantsCase('lifecycle-prepare')) {
			for (const account of rotationAccounts) {
				await prepareRotationAccount(browser, account, audit);
			}
		}
		if (wantsCase('lifecycle-verify')) {
			for (const account of rotationAccounts) {
				await verifyRotationAccount(browser, account, audit);
			}
		}
		if (wantsCase('route')) {
			for (const account of [accounts[0], accounts[2]].filter(wantsAccount)) {
				await probePublicRoute(account, audit, 'public-route-post-workflow-h2');
			}
		}
	} finally {
		const report = audit.writeReport();
		console.log(JSON.stringify({
			report: rel(report.mdFile),
			json: rel(report.jsonFile),
			artifactRoot: rel(artifactRoot)
		}, null, 2));
	}
	const failures = audit.records.filter(record => 'error' === record.status);
	if (failures.length) {
		throw new Error(`Email client audit recorded ${failures.length} failures. See ${rel(artifactRoot)}/report.md`);
	}
});
