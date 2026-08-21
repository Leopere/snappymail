const fs = require('fs');
const { test, expect } = require('@playwright/test');

const envFile = process.env.SNAPPYMAIL_AUDIT_ENV
	|| '/Users/aedev/.config/codex/snappymail-miab-audit-users.env';

const readSecrets = file => {
	const result = {};
	for (const line of fs.readFileSync(file, 'utf8').split(/\n/)) {
		const match = line.match(/^export\s+([A-Z0-9_]+)='([^']*)'$/);
		match && (result[match[1]] = match[2]);
	}
	return result;
};

const secrets = readSecrets(envFile);
const account = {
	baseURL: process.env.SNAPPYMAIL_AUDIT_NIXC_URL || 'https://mail.nixc.us',
	email: secrets.SNAPPYMAIL_AUDIT_NIXC_B_EMAIL,
	password: secrets.SNAPPYMAIL_AUDIT_NIXC_B_PASSWORD
};

const waitForMailbox = async page => {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await page.waitForSelector('.messageListItem', {timeout: 20000});
			return;
		} catch (error) {
			if (2 === attempt) {
				throw error;
			}
			await page.evaluate(() => rl.app?.messageList?.reload(false, true));
		}
	}
};

const login = async page => {
	await page.goto(account.baseURL, {waitUntil: 'commit', timeout: 45000});
	await page.locator('input[name=Email]').fill(account.email);
	await page.locator('input[name=Password]').fill(account.password);
	await page.locator('.buttonLogin').click();
	await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true, null, {timeout: 90000});
	await waitForMailbox(page);
};

const action = (page, params) => page.evaluate(async values => {
	const base = location.pathname.replace(/\/+$/, '') + '/';
	return rl.fetchJSON(base + '?/Json/&q[]=/0/', {}, values);
}, params);

const togglePinned = async (page, row) => {
	const completed = page.waitForResponse(response =>
		'POST' === response.request().method()
			&& (response.request().postData() || '').includes('MessageSetFlagged'),
	{timeout: 15000});
	await row.locator('.flagParent').click();
	const response = await completed;
	expect(response.ok()).toBe(true);
	await response.finished();
	await page.waitForFunction(() => !rl.app.messageList.mutationLoading(), null, {timeout: 15000});
};

const swipe = async (page, row, from, to) => {
	const box = await row.boundingBox();
	expect(box).toBeTruthy();
	await page.mouse.move(box.x + from, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + to, box.y + box.height / 2, {steps: 6});
	await page.mouse.up();
};

test('authenticated Snooze moves and restores one folder-local conversation', async ({browser}) => {
	test.setTimeout(180000);
	const context = await browser.newContext({viewport: {width: 390, height: 844}, ignoreHTTPSErrors: true});
	const page = await context.newPage();
	let message, snoozeId = '';

	try {
		await login(page);
		const threading = await page.evaluate(() => ({
			algorithm: rl.settings.get('threadAlgorithm'),
			enabled: rl.settings.get('useThreads')
		}));
		expect(threading).toEqual({algorithm: 'REFS', enabled: true});
		message = await page.locator('.messageListItem').first().evaluate(row => {
			const item = ko.dataFor(row);
			return {
				folder: item.folder,
				pinned: item.isFlagged(),
				subject: item.subject(),
				uid: item.uid,
				uids: [item.uid, ...item.threads()]
			};
		});
		const firstRow = page.locator('.messageListItem').first();
		await togglePinned(page, firstRow);
		await expect.poll(() => firstRow.evaluate(row => ko.dataFor(row).isFlagged())).toBe(!message.pinned);
		await togglePinned(page, firstRow);
		await expect.poll(() => firstRow.evaluate(row => ko.dataFor(row).isFlagged())).toBe(message.pinned);
		await swipe(page, firstRow, 180, 140);
		await expect(firstRow).not.toHaveAttribute('data-swipe-action');
		await expect(page.locator('.messageActionUndo')).toBeHidden();
		await swipe(page, firstRow, 180, 85);
		await expect(page.locator('.messageActionUndo')).toBeVisible();
		await page.locator('.messageActionUndo button').click();
		await expect(page.locator('.messageActionUndo')).toBeHidden();
		await page.waitForTimeout(5200);
		await expect(page.locator('.messageListItem').filter({hasText: message.subject}).first()).toBeVisible();
		await swipe(page, firstRow, 80, 175);
		await expect(page.locator('.messageActionUndo')).toBeVisible();
		await page.locator('.messageActionUndo button').click();
		await expect(page.locator('.messageActionUndo')).toBeHidden();
		await page.waitForTimeout(5200);
		await expect(page.locator('.messageListItem').filter({hasText: message.subject}).first()).toBeVisible();

		await page.evaluate(detail => dispatchEvent(new CustomEvent(
			'mailbox.message.snooze-request', {detail: detail}
		)), message);
		await expect(page.locator('#V-PopupsSnooze')).toBeVisible();
		await page.locator('#V-PopupsSnooze .close').click();

		const created = await action(page, {
			Action: 'SnoozeCreate',
			folder: message.folder,
			uid: message.uid,
			uids: message.uids.join(','),
			wakeAt: Math.floor(Date.now() / 1000) + 3600
		});
		expect(created.Result?.status).toBe('active');
		snoozeId = created.Result.id;

		const listed = await action(page, {Action: 'SnoozeList'});
		expect(listed.Result.some(record => record.id === snoozeId && 'active' === record.status)).toBe(true);

		const cancelled = await action(page, {Action: 'SnoozeCancel', id: snoozeId});
		expect(cancelled.Result?.status).toBe('cancelled');
		snoozeId = '';

		await page.evaluate(() => rl.app.messageList.reload(false, true));
		await waitForMailbox(page);
		await expect(page.locator('.messageListItem').filter({hasText: message.subject}).first()).toBeVisible();
		await page.locator('#V-MailMessageList .toggleLeft').click();
		await expect(page.locator('#rl-left .pinnedShortcut')).toContainText('Pinned');
		await expect(page.locator('#rl-left .b-folders-inbox')).toContainText('Snoozed');
		await expect(page.locator('#rl-left .b-folders-inbox')).toContainText('Done');
	} finally {
		if (snoozeId) {
			await action(page, {Action: 'SnoozeCancel', id: snoozeId}).catch(() => {});
		}
		if (message) {
			await action(page, {
				Action: 'MessageSetFlagged',
				folder: message.folder,
				uids: message.uids.join(','),
				setAction: message.pinned ? 1 : 0
			}).catch(() => {});
		}
		await context.close();
	}
});

test('due Snooze restores and sends one authenticated self-reminder', async ({browser}) => {
	test.skip('1' !== process.env.SNAPPYMAIL_TEST_SNOOZE_DUE, 'long-running live due test is opt-in');
	test.setTimeout(150000);
	const context = await browser.newContext({viewport: {width: 390, height: 844}, ignoreHTTPSErrors: true});
	const page = await context.newPage();
	let snoozeId = '', reminderUids = [], folder = 'INBOX';

	try {
		await login(page);
		const message = await page.locator('.messageListItem').first().evaluate(row => {
			const item = ko.dataFor(row);
			return {
				folder: item.folder,
				subject: item.subject(),
				uid: item.uid,
				uids: [item.uid, ...item.threads()]
			};
		});
		folder = message.folder;
		const created = await action(page, {
			Action: 'SnoozeCreate',
			folder: message.folder,
			uid: message.uid,
			uids: message.uids.join(','),
			wakeAt: Math.floor(Date.now() / 1000) + 62
		});
		expect(created.Result?.status).toBe('active');
		snoozeId = created.Result.id;

		await page.waitForTimeout(63000);
		const processed = await action(page, {Action: 'SnoozeProcessDue'}),
			event = processed.Result.find(item => item.id === snoozeId);
		expect(event?.status).toBe('restored');
		expect(event?.reminderStatus).toBe('sent');
		snoozeId = '';

		const reminderSearch = 'subject=Reminder: ' + message.subject;
		for (let attempt = 0; attempt < 10 && !reminderUids.length; attempt += 1) {
			const found = await action(page, {
				Action: 'MessageListUids',
				folder: message.folder,
				search: reminderSearch,
				sort: '',
				threadUid: 0,
				useThreads: 0
			});
			reminderUids = found.Result?.uids || [];
			if (!reminderUids.length) {
				await page.waitForTimeout(1000);
			}
		}
		expect(reminderUids.length).toBeGreaterThan(0);
	} finally {
		if (snoozeId) {
			await action(page, {Action: 'SnoozeCancel', id: snoozeId}).catch(() => {});
		}
		if (reminderUids.length) {
			await action(page, {
				Action: 'MessageDelete',
				folder: folder,
				uids: reminderUids.join(',')
			}).catch(() => {});
		}
		await context.close();
	}
});
