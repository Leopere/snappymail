const fs = require('fs');
const { test, expect } = require('@playwright/test');

const envFile = process.env.SNAPPYMAIL_AUDIT_ENV
	|| '/Users/aedev/.config/codex/snappymail-miab-audit-users.env';

const secrets = Object.fromEntries(
	fs.readFileSync(envFile, 'utf8').split(/\n/).flatMap(line => {
		const match = line.match(/^export\s+([A-Z0-9_]+)='([^']*)'$/);
		return match ? [[match[1], match[2]]] : [];
	})
);

const baseURL = process.env.SNAPPYMAIL_AUDIT_BOOMPAY_URL || 'https://mail.boompay.ca';
const accounts = {
	a: {
		email: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_A_EMAIL,
		password: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_A_PASSWORD
	},
	b: {
		email: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_B_EMAIL,
		password: secrets.SNAPPYMAIL_AUDIT_BOOMPAY_B_PASSWORD
	}
};

const login = async (page, account) => {
	await page.goto(baseURL, { waitUntil: 'commit', timeout: 45000 });
	await page.locator('input[name=Email]').fill(account.email);
	await page.locator('input[name=Password]').fill(account.password);
	await page.locator('.buttonLogin').click();
	await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true, null, { timeout: 90000 });
	await page.locator('.messageList').waitFor({ state: 'visible', timeout: 45000 });
};

const action = (page, params) => page.evaluate(async values => {
	const base = location.pathname.replace(/\/+$/, '') + '/';
	return rl.fetchJSON(base + '?/Json/&q[]=/0/', {}, values);
}, params);

const reloadList = async page => {
	const response = page.waitForResponse(item =>
		'POST' === item.request().method()
			&& (item.request().postData() || '').includes('MessageList'),
	{ timeout: 30000 }).catch(() => null);
	await page.evaluate(() => rl.app?.messageList?.reload(false, true));
	await response;
};

const findRow = (page, subject) => page.locator('.messageListItem').filter({ hasText: subject }).first();

const waitForRow = async (page, subject, attempts = 15) => {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const row = findRow(page, subject);
		if (await row.isVisible().catch(() => false)) {
			return row;
		}
		await reloadList(page);
		await page.waitForTimeout(750);
	}
	throw new Error(`Timed out waiting for message: ${subject}`);
};

const deleteSearch = async (page, folder, search) => {
	const found = await action(page, {
		Action: 'MessageListUids',
		folder,
		search,
		sort: '',
		threadUid: 0,
		useThreads: 0
	});
	const uids = found.Result?.uids || [];
	if (uids.length) {
		await action(page, {
			Action: 'MessageDelete',
			folder,
			uids: uids.join(',')
		});
	}
};

test.use({
	viewport: { width: 390, height: 844 },
	ignoreHTTPSErrors: true
});

test('a displayed MDN marks and opens its exact Sent message', async ({ browser }) => {
	test.setTimeout(240000);
	const run = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
	const subject = `Read receipt round trip ${run}`;
	const body = `Receipt test body ${run}`;
	const subjectSearch = `subject:"${subject.replace(/([\\"])/g, '\\$1')}"`;
	const aContext = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
	const bContext = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
	const aPage = await aContext.newPage();
	const bPage = await bContext.newPage();
	let messageId = '';

	try {
		await login(aPage, accounts.a);
		expect(await aPage.evaluate(() => rl.settings.get('requestReadReceipt'))).toBe(true);
		await aPage.locator('#rl-left .buttonCompose:visible, #V-MailMessageList .buttonCompose:visible').first().click();
		const compose = aPage.locator('#V-PopupsCompose');
		await compose.waitFor({ state: 'visible', timeout: 15000 });
		expect(await compose.evaluate(element => !!ko.dataFor(element).requestReadReceipt())).toBe(true);
		await compose.locator('.emailaddresses input').first().fill(accounts.b.email);
		await aPage.keyboard.press('Enter');
		await compose.locator('input[name="subject"]').fill(subject);
		await compose.evaluate((element, value) => {
			const view = ko.dataFor(element);
			view.editor(editor => editor.setPlain(value));
			view.requestDsn(false);
		}, body);
		await compose.locator('header > a.btn').first().click();
		await aPage.waitForFunction(element => {
			const view = ko.dataFor(element);
			return !view?.modalVisible?.() || view?.sendError?.();
		}, await compose.elementHandle(), { timeout: 90000 });
		const sendState = await compose.evaluate(element => {
			const view = ko.dataFor(element);
			return { error: !!view?.sendError?.(), message: view?.sendErrorDesc?.() || '' };
		});
		expect(sendState, sendState.message).toEqual({ error: false, message: '' });

		await aPage.goto(`${baseURL}/#/mailbox/Sent`);
		const sentRow = await waitForRow(aPage, subject);
		messageId = await sentRow.evaluate(row => ko.dataFor(row).messageId);
		expect(messageId).toMatch(/^<[^<>\r\n]+>$/);

		await login(bPage, accounts.b);
		await bPage.goto(`${baseURL}/#/mailbox/INBOX`);
		const receivedRow = await waitForRow(bPage, subject, 30);
		await receivedRow.locator('.subjectParent').click();
		await bPage.waitForFunction(expected =>
			ko.dataFor(document.querySelector('#V-MailMessageView'))?.message?.()?.subject?.() === expected,
		subject, { timeout: 60000 });
		const receiptPrompt = bPage.locator('#V-MailMessageView .readReceipt:visible');
		await expect(receiptPrompt).toBeVisible({ timeout: 30000 });
		const receiptResponse = bPage.waitForResponse(response =>
			'POST' === response.request().method()
				&& (response.request().postData() || '').includes('SendReadReceiptMessage'),
		{ timeout: 60000 });
		await receiptPrompt.click();
		const mdnResponse = await receiptResponse;
		expect(mdnResponse.ok()).toBe(true);
		expect((await mdnResponse.json()).Result).toBe(true);

		let readRow;
		for (let attempt = 0; attempt < 15; attempt += 1) {
			await aPage.goto(`${baseURL}/#/mailbox/INBOX`);
			await aPage.locator('.messageList').waitFor({ state: 'visible' });
			await reloadList(aPage);
			await expect(findRow(aPage, `Return Receipt (displayed) - ${subject}`)).toHaveCount(0);
			await aPage.goto(`${baseURL}/#/mailbox/Sent`);
			readRow = findRow(aPage, subject);
			if (await readRow.locator('.readSuccessIcon').isVisible().catch(() => false)) {
				break;
			}
			await aPage.waitForTimeout(1000);
		}

		const readStatus = readRow.locator('.readSuccessIcon');
		await expect(readStatus).toBeVisible();
		await expect(readStatus).toHaveAttribute('aria-label', 'Read receipt received. View receipt.');
		await expect(readRow.locator('.deliverySuccessIcon')).toBeHidden();
		const sentState = await readRow.evaluate(row => ({
			flags: ko.dataFor(row).flags(),
			right: row.getBoundingClientRect().right,
			viewport: innerWidth,
			documentWidth: document.documentElement.scrollWidth
		}));
		expect(sentState.flags).toContain('$readsuccess');
		expect(sentState.right).toBeLessThanOrEqual(sentState.viewport);
		expect(sentState.documentWidth).toBeLessThanOrEqual(sentState.viewport);

		await readStatus.click();
		await expect(aPage.locator('.listSearchDesc')).toContainText('multipart/report');
		const rawRow = await waitForRow(aPage, `Return Receipt (displayed) - ${subject}`);
		const rawState = await rawRow.evaluate(row => ({
			flags: ko.dataFor(row).flags(),
			url: ko.dataFor(row).viewRaw()
		}));
		expect(rawState.flags).toContain('\\seen');
		expect(rawState.flags).toContain('$readprocessed');
		const rawResponse = await aPage.request.get(new URL(rawState.url, baseURL).href);
		expect(rawResponse.ok()).toBe(true);
		const raw = await rawResponse.text();
		expect(raw).toMatch(/^Return-Path:\s*<>/mi);
		expect(raw).toMatch(/Content-Type:\s*multipart\/report;\s*report-type="?disposition-notification"?/i);
		expect(raw).toMatch(/Content-Type:\s*message\/disposition-notification/i);
		expect(raw).toContain(`Original-Message-ID: ${messageId}`);
		expect(raw).toMatch(/Disposition:\s*manual-action\/MDN-sent-manually;\s*displayed/i);
	} finally {
		if (!aPage.isClosed() && await aPage.evaluate(() => window.rl?.settings?.get?.('Auth') === true).catch(() => false)) {
			await deleteSearch(aPage, 'Sent', subjectSearch).catch(() => {});
			await deleteSearch(aPage, 'INBOX', subjectSearch).catch(() => {});
			if (messageId) {
				const messageSearch = `body:"${messageId.replace(/([\\"])/g, '\\$1')}"`;
				await deleteSearch(aPage, 'INBOX', messageSearch).catch(() => {});
			}
		}
		if (!bPage.isClosed() && await bPage.evaluate(() => window.rl?.settings?.get?.('Auth') === true).catch(() => false)) {
			await deleteSearch(bPage, 'INBOX', subjectSearch).catch(() => {});
		}
		await aContext.close();
		await bContext.close();
	}
});
