const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const baseURL = process.env.SNAPPYMAIL_BASE_URL || 'http://127.0.0.1:8888';
const email = process.env.SNAPPYMAIL_TEST_EMAIL || 'test@example.com';
const password = process.env.SNAPPYMAIL_TEST_PASSWORD || 'MrcTest2026!';
const secondaryEmail = process.env.SNAPPYMAIL_SECONDARY_EMAIL || 'teammate@example.com';
const secondaryPassword = process.env.SNAPPYMAIL_SECONDARY_PASSWORD || password;
const screenshotDir = path.resolve(__dirname, '../../tmp/playwright');
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '';

test.use({
	baseURL,
	launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {}
});

const login = async (page, accountEmail = email, accountPassword = password) => {
	await page.goto(baseURL);
	await page.locator('input[name=Email]').fill(accountEmail);
	await page.locator('input[name=Password]').fill(accountPassword);
	await page.locator('.buttonLogin').click();
	await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true, null, {
		timeout: 60000
	});
	await page.waitForSelector('#rl-content:not([hidden])', {
		timeout: 30000
	});
};

const waitForMailboxList = page => page.waitForFunction(() =>
	document.querySelectorAll('.messageListItem').length
	|| document.body.innerText.includes('Empty list.')
, null, {
	timeout: 30000
});

const buttonGaps = async (page, selector) => page.locator(selector).evaluate(toolbar => {
	const rows = [];
	const controls = Array.from(toolbar.querySelectorAll(':scope > .btn, :scope > .btn-group > .btn'));

	controls.forEach(control => {
		const rect = control.getBoundingClientRect();
		const style = getComputedStyle(control);

		if ('none' === style.display || 'hidden' === style.visibility || rect.width <= 0 || rect.height <= 0) {
			return;
		}

		let row = rows.find(item => Math.abs(item.top - rect.top) < 4);
		if (!row) {
			row = { top: rect.top, boxes: [] };
			rows.push(row);
		}

		row.boxes.push({
			left: rect.left,
			right: rect.right
		});
	});

	return rows.flatMap(row => {
		const boxes = row.boxes.sort((a, b) => a.left - b.left);
		const gaps = [];

		for (let index = 1; index < boxes.length; index += 1) {
			gaps.push(Math.round((boxes[index].left - boxes[index - 1].right) * 100) / 100);
		}

		return gaps;
	});
});

test.beforeAll(() => {
	fs.mkdirSync(screenshotDir, { recursive: true });
});

test('desktop mailbox and compose action', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);
	await waitForMailboxList(page);

	const compose = page.locator('#rl-left .buttonCompose').first();
	await expect(compose).toBeVisible();

	const composeStyle = await compose.evaluate(element => {
		const style = getComputedStyle(element);
		return {
			backgroundColor: style.backgroundColor,
			borderRadius: style.borderRadius,
			boxShadow: style.boxShadow,
			color: style.color,
			height: style.height,
			width: style.width
		};
	});
	const themeState = await page.evaluate(() => ({
		theme: window.rl?.settings?.get?.('Theme'),
		styleTheme: document.getElementById('app-theme-style')?.dataset?.name,
		capaThemes: window.rl?.settings?.get?.('Capa')?.Themes,
		themes: window.rl?.settings?.app?.('themes')
	}));

	await page.screenshot({
		fullPage: true,
		path: path.join(screenshotDir, 'desktop-mailbox.png')
	});
	await compose.screenshot({
		path: path.join(screenshotDir, 'desktop-compose-button.png')
	});

	expect(composeStyle.borderRadius).toBe('8px');
	expect(themeState).toMatchObject({
		theme: 'MotherboardRepairCanada',
		styleTheme: 'MotherboardRepairCanada',
		capaThemes: false,
		themes: ['MotherboardRepairCanada']
	});

	const gaps = await buttonGaps(page, '#V-MailMessageList > .btn-toolbar');
	expect(gaps.length).toBeGreaterThan(0);
	expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5);

	console.log(JSON.stringify({ screenshotDir, composeStyle }, null, 2));
});

test('mobile mailbox compose action', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);
	await waitForMailboxList(page);

	const compose = page.locator('#V-MailMessageList .buttonCompose').first();
	await expect(compose).toBeVisible();

	const gaps = await buttonGaps(page, '#V-MailMessageList > .btn-toolbar');
	expect(gaps.length).toBeGreaterThan(0);
	expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5);

	await page.screenshot({
		fullPage: true,
		path: path.join(screenshotDir, 'mobile-mailbox.png')
	});
});

test('keyboard shortcut help opens with question mark', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);

	await page.locator('#V-MailMessageView').click();
	await page.keyboard.press('Shift+/');

	const popup = page.locator('#V-PopupsKeyboardShortcutsHelp');
	await expect(popup).toBeVisible();
	await expect(popup).toHaveClass(/animate/);
	await page.waitForTimeout(300);
	await expect(popup.locator('h3')).toHaveText('Keyboard shortcuts help');
	await expect(popup.locator('.keyboard-shortcuts-generated > label')).toHaveCount(6);
	await expect(popup).toContainText('Alt + B');

	await page.screenshot({
		path: path.join(screenshotDir, 'shortcuts-help.png')
	});
});

test('compose field hotkeys toggle optional recipients', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);

	await page.locator('#rl-left .buttonCompose').click();

	const compose = page.locator('#V-PopupsCompose');
	await expect(compose).toBeVisible();
	await expect(compose).toHaveClass(/animate/);

	await expect(compose.locator('.bcc-row')).not.toBeVisible();
	await page.keyboard.press('Alt+B');
	await expect(compose.locator('.bcc-row')).toBeVisible();

	await expect(compose.locator('.cc-row')).not.toBeVisible();
	await page.keyboard.press('Alt+C');
	await expect(compose.locator('.cc-row')).toBeVisible();
});

test('internal recipients auto-enable GnuPG sign and encrypt', async ({ page }) => {
	test.setTimeout(90000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);

	await page.locator('#rl-left .buttonCompose').click();

	const compose = page.locator('#V-PopupsCompose');
	await expect(compose).toBeVisible();
	await expect(compose).toHaveClass(/animate/);

	await compose.locator('.emailaddresses input').first().fill(email);
	await page.keyboard.press('Enter');

	await expect.poll(async () => compose.evaluate(element => {
		const vm = ko.dataFor(element);
		const state = vm?.internalGnuPGState?.();
		return Boolean(
			vm?.doSign?.()
			&& vm?.doEncrypt?.()
			&& state?.ready
			&& vm?.signOptionsText?.().includes('GnuPG')
			&& vm?.encryptOptionsText?.().startsWith('GnuPG')
		);
	}), {
		timeout: 60000
	}).toBe(true);

	await expect(compose.locator('[data-i18n="[title]CRYPTO/SIGN"]')).toHaveClass(/btn-success/);
	await expect(compose.locator('[data-i18n="[title]CRYPTO/ENCRYPT"]')).toHaveClass(/btn-success/);
});

test('internal GnuPG message sends to secondary account and auto-decrypts', async ({ browser }) => {
	test.setTimeout(120000);

	const subject = `GnuPG intra-company Playwright ${Date.now()}`,
		body = `Encrypted intra-company Playwright body ${Date.now()}`,
		senderContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
		sender = await senderContext.newPage();

	await login(sender);
	await sender.locator('#rl-left .buttonCompose').click();

	const compose = sender.locator('#V-PopupsCompose');
	await expect(compose).toBeVisible();

	await compose.locator('.emailaddresses input').first().fill(secondaryEmail);
	await sender.keyboard.press('Enter');
	await compose.locator('input[name="subject"]').fill(subject);
	await compose.evaluate((element, value) =>
		ko.dataFor(element).editor(editor => editor.setPlain(value))
	, body);

	await expect.poll(async () => compose.evaluate(element => {
		const vm = ko.dataFor(element);
		return Boolean(
			vm?.doSign?.()
			&& vm?.doEncrypt?.()
			&& vm?.internalGnuPGState?.().ready
			&& vm?.signOptionsText?.().includes('GnuPG')
			&& vm?.encryptOptionsText?.().startsWith('GnuPG')
		);
	}), {
		timeout: 60000
	}).toBe(true);

	const paramsPreview = await compose.evaluate(async element => {
		const params = await ko.dataFor(element).getMessageRequestParams('', false);
		return {
			signFingerprint: params.signFingerprint,
			signPassphrase: Boolean(params.signPassphrase),
			encryptFingerprints: JSON.parse(params.encryptFingerprints || '[]')
		};
	});
	expect(paramsPreview.signFingerprint).toBeTruthy();
	expect(paramsPreview.signPassphrase).toBe(true);
	expect(paramsPreview.encryptFingerprints.length).toBe(2);

	await compose.evaluate(element => ko.dataFor(element).sendCommand());
	await sender.waitForFunction(() => {
		const element = document.querySelector('#V-PopupsCompose');
		return !element || element.hidden || !ko.dataFor(element)?.modalVisible?.();
	}, null, {
		timeout: 90000
	});
	await senderContext.close();

	const recipientContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
		recipient = await recipientContext.newPage();
	await login(recipient, secondaryEmail, secondaryPassword);
	await recipient.getByText(subject, { exact: true }).first().click({ force: true });
	await recipient.waitForFunction(expected => document.body.innerText.includes(expected), body, {
		timeout: 60000
	});

	const received = await recipient.locator('#V-MailMessageView').evaluate(element => {
		const message = ko.dataFor(element)?.message?.(),
			text = element.innerText;
		return {
			pgpDecrypted: message?.pgpDecrypted?.(),
			hasBody: text.includes('Encrypted intra-company Playwright body'),
			hasArmor: text.includes('BEGIN PGP MESSAGE')
		};
	});

	expect(received).toMatchObject({
		pgpDecrypted: true,
		hasBody: true,
		hasArmor: false
	});
	await recipientContext.close();
});

test('security encryption summary', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);
	await page.evaluate(() => location.hash = '#/settings/security');

	const summary = page.locator('.encryption-summary');
	await expect(summary).toContainText('Ready', { timeout: 30000 });
	await expect(page.locator('details.advanced-keys')).not.toHaveAttribute('open', '');

	await page.screenshot({
		fullPage: true,
		path: path.join(screenshotDir, 'settings-security.png')
	});
});
