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
const screenshotHost = new URL(baseURL).hostname.replace(/[^a-z0-9.-]+/gi, '-');

test.use({
	baseURL,
	launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {}
});

const login = async (page, accountEmail = email, accountPassword = password) => {
	await page.goto(baseURL, { waitUntil: 'commit', timeout: 45000 });
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

const waitForDialogSettled = dialog => dialog.evaluate(element => new Promise(resolve => {
	let previous = '', stableFrames = 0;
	const check = () => {
		const box = element.getBoundingClientRect(),
			current = [box.top, box.left, box.width, box.height].map(Math.round).join(':');
		stableFrames = current === previous ? stableFrames + 1 : 0;
		previous = current;
		stableFrames > 2 ? resolve() : requestAnimationFrame(check);
	};
	check();
}));

const openCompose = async page => {
	await waitForMailboxList(page);
	const button = page.locator('#rl-left .buttonCompose').first();
	await expect(button).toBeVisible();
	await button.click();
	const compose = page.locator('#V-PopupsCompose');
	await expect(compose).toBeVisible({ timeout: 10000 });
	return compose;
};

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

test('public login shell sends one privacy-safe Notomo pageview', async ({ page }) => {
	const siteId = {
		'boompay.ca': 'boompay.ca',
		'mail.boompay.ca': 'boompay.ca',
		'mail.nixc.us': 'nixc.us'
	}[screenshotHost];
	test.skip(!siteId, 'Notomo is enabled only on the public branded hosts.');

	const requests = [];
	page.on('request', request => requests.push(request.url()));
	const loginURL = new URL(baseURL);
	loginURL.searchParams.set('utm_source', 'snappymail-test');
	loginURL.searchParams.set('utm_campaign', 'login-privacy');
	const pixelResponse = page.waitForResponse(response =>
		'https://notomo.colinknapp.com/n.gif' === new URL(response.url()).origin
			+ new URL(response.url()).pathname
	, { timeout: 15000 });

	await page.goto(loginURL.href, { waitUntil: 'commit', timeout: 45000 });
	await expect(page.locator('input[name=Email]')).toBeVisible();
	const response = await pixelResponse,
		pixel = new URL(response.url());
	expect(response.status()).toBe(200);
	expect(pixel.searchParams.get('s')).toBe(siteId);
	expect(pixel.searchParams.get('u')).toBe(loginURL.origin + loginURL.pathname);
	expect(pixel.searchParams.get('utm_source')).toBe('snappymail-test');
	expect(pixel.searchParams.get('utm_campaign')).toBe('login-privacy');
	expect(requests.some(url => url.includes('notomo.colinknapp.com/n.js'))).toBe(false);
});

test('public boot survives two consecutive transport aborts', async ({ page }) => {
	const failures = { AppData: 0, Ping: 0 };
	await page.route('**/*', route => {
		const url = route.request().url(),
			type = url.includes('/AppData/') ? 'AppData' : (url.includes('/Ping/0/') ? 'Ping' : '');
		if (type && failures[type] < 2) {
			failures[type] += 1;
			return route.abort('timedout');
		}
		return route.continue();
	});

	await page.goto(baseURL, { waitUntil: 'commit', timeout: 45000 });
	await expect(page.locator('input[name=Email]')).toBeVisible({ timeout: 15000 });
	await expect(page.locator('#rl-loading-error')).toBeHidden();
	expect(failures).toEqual({ AppData: 2, Ping: 2 });
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

test('category metadata stays out of the sidebar and routing remains configurable', async ({ page }) => {
	test.setTimeout(60000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);
	await waitForMailboxList(page);
	const identity = page.locator('#V-PopupsIdentity');
	if (await identity.waitFor({ state: 'visible', timeout: 5000 })
		.then(() => true).catch(() => false)) {
		await identity.locator('input[name=Name]').fill('SnappyMail Category Test');
		await identity.locator('button.buttonAddIdentity').click();
		await identity.waitFor({ state: 'hidden', timeout: 15000 });
	}
	const smartArchiveSaved = await page.evaluate(() => new Promise(resolve =>
		rl.app.Remote.saveSetting('SmartArchiveEnabled', true, error => resolve(!error))
	));
	expect(smartArchiveSaved).toBe(true);
	await page.reload({ waitUntil: 'commit' });
	await waitForMailboxList(page);

	await expect(page.locator('.b-folders-categories')).toHaveCount(0);

	await page.evaluate(() => location.hash = '#/settings/folders');
	const routes = page.locator('.category-routing-list tbody tr');
	await expect(routes).toHaveCount(6);
	await expect(routes.first().locator('option').first()).toHaveText('Keep in Inbox');
	await expect(page.locator('.category-routing-title')).toHaveText('Category move destinations');

	const financeRoute = routes.nth(2),
		financeSelect = financeRoute.locator('select'),
		waitForSettingsUpdate = () => page.waitForResponse(response =>
			response.request().postData()?.includes('CategoryFolderRoutes')
		);
	const autoSetup = page.getByRole('button', { name: 'Suggest destinations' }),
		autoSetupUpdate = waitForSettingsUpdate();
	await autoSetup.click();
	await expect((await autoSetupUpdate).ok()).toBe(true);
	await expect(autoSetup).toBeEnabled();
	await page.waitForFunction(() => Array.from(document.querySelectorAll('.category-routing-list select'))
		.every(select => !!select.value), null, { timeout: 30000 });
	await expect(financeSelect.locator('option[value="INBOX"]')).toBeDisabled();

	const routeFolder = await financeSelect.inputValue();
	expect(routeFolder).not.toBe('');
	expect(routeFolder).not.toBe('INBOX');
	const optOutUpdate = waitForSettingsUpdate();
	await financeSelect.selectOption('');
	await expect((await optOutUpdate).ok()).toBe(true);
	await page.reload({ waitUntil: 'commit' });
	await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true);
	await expect(routes).toHaveCount(6);
	await expect(financeSelect).toHaveValue('');

	const restoreUpdate = waitForSettingsUpdate();
	await autoSetup.click();
	await expect((await restoreUpdate).ok()).toBe(true);
	await expect(financeSelect).toHaveValue(routeFolder);

	const invalidRouteSaved = await page.evaluate(() => new Promise(resolve => {
		const view = ko.dataFor(document.querySelector('#V-Settings-Folders')),
			routes = Object.fromEntries(view.categoryRoutes.map(route => [route.value, route.folder()]));
		routes.finance = 'Missing Category Folder';
		rl.app.Remote.saveSetting('CategoryFolderRoutes', JSON.stringify(routes), error => resolve(!error));
	}));
	expect(invalidRouteSaved).toBe(true);
	await page.reload({ waitUntil: 'commit' });
	await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true);
	await expect(routes).toHaveCount(6);
	await expect(financeSelect).toHaveValue(routeFolder);

	await page.evaluate(() => location.hash = '#/mailbox/INBOX');
	await waitForMailboxList(page);
	await expect(page.locator('.b-folders-categories')).toHaveCount(0);
});

test('mobile mailbox compose action', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);
	await expect(page.locator('#V-MailMessageList .buttonCompose').first()).toBeVisible({ timeout: 30000 });

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

test('mobile message swipe ignores scroll wobble and eases out of its dead zone', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);
	await waitForMailboxList(page);

	const state = await page.locator('#V-MailMessageList .b-content').evaluate(content => {
		const row = document.createElement('div');
		row.className = 'messageListItem';
		row.innerHTML = '<div class="messageSwipeActions"><div class="messageSwipeAction messageSwipeActionStart"></div>'
			+ '<div class="messageSwipeAction messageSwipeActionEnd"></div></div>'
			+ '<div class="messageListItemForeground"><div class="messageListItemContent">Swipe test</div></div>';
		row.setPointerCapture = () => {};
		row.releasePointerCapture = () => {};
		row.hasPointerCapture = () => false;
		content.prepend(row);
		const spacer = document.createElement('div');
		spacer.style.height = '1200px';
		content.append(spacer);
		content.scrollTop = 80;
		const before = row.getBoundingClientRect();

		const emit = (type, x, y, pointerId) => row.dispatchEvent(new PointerEvent(type, {
			bubbles: true,
			button: 0,
			clientX: x,
			clientY: y,
			isPrimary: true,
			pointerId
		}));

		emit('pointerdown', 100, 100, 71);
		emit('pointermove', 113, 106, 71);
		const wobble = {
			active: row.classList.contains('swipe-active'),
			x: row.style.getPropertyValue('--message-swipe-x')
		};
		emit('pointermove', 114, 120, 71);
		const scrolled = {
			active: row.classList.contains('swipe-active'),
			x: row.style.getPropertyValue('--message-swipe-x')
		};

		emit('pointerdown', 100, 100, 72);
		emit('pointermove', 118, 102, 72);
		const during = row.getBoundingClientRect();
		const engaged = {
			active: row.classList.contains('swipe-active'),
			direction: row.dataset.swipeDirection,
			height: during.height,
			listLocked: content.classList.contains('swipe-locked'),
			width: during.width,
			x: row.style.getPropertyValue('--message-swipe-x')
		};
		emit('pointermove', 130, 102, 72);
		const moved = row.style.getPropertyValue('--message-swipe-x');
		content.scrollTop = 180;
		content.dispatchEvent(new Event('scroll'));
		const lockedScrollTop = content.scrollTop;
		emit('pointermove', 70, 102, 72);
		const reversed = {
			action: row.dataset.swipeAction || null,
			direction: row.dataset.swipeDirection || null,
			x: row.style.getPropertyValue('--message-swipe-x')
		};
		emit('pointercancel', 70, 102, 72);
		const cancelled = {
			active: row.classList.contains('swipe-active'),
			listLocked: content.classList.contains('swipe-locked'),
			x: row.style.getPropertyValue('--message-swipe-x')
		};
		const after = row.getBoundingClientRect();
		spacer.remove();
		row.remove();

		return {
			after: {height: after.height, width: after.width},
			before: {height: before.height, width: before.width},
			cancelled,
			engaged,
			lockedScrollTop,
			moved,
			reversed,
			scrolled,
			wobble
		};
	});

	expect(state.wobble).toEqual({ active: false, x: '' });
	expect(state.scrolled).toEqual({ active: false, x: '' });
	expect(state.engaged).toEqual({
		active: true,
		direction: 'right',
		height: state.before.height,
		listLocked: true,
		width: state.before.width,
		x: '0px'
	});
	expect(state.lockedScrollTop).toBe(80);
	expect(state.moved).toBe('12px');
	expect(state.reversed).toEqual({ action: null, direction: null, x: '0px' });
	expect(state.cancelled).toEqual({ active: false, listLocked: false, x: '' });
	expect(state.after).toEqual(state.before);
});

test('mobile rich text toolbar keeps common actions in one touch-sized row', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);
	await waitForMailboxList(page);

	await page.locator('#V-MailMessageList .buttonCompose').first().click();
	const compose = page.locator('#V-PopupsCompose'),
		toolbar = compose.locator('.squire-toolbar');
	await expect(compose).toBeVisible({ timeout: 10000 });
	await waitForDialogSettled(compose);
	await expect(toolbar).toBeVisible();

	const toolbarState = () => toolbar.evaluate(element => {
		const controls = Array.from(element.querySelectorAll('button, select')).filter(control => {
			const box = control.getBoundingClientRect(),
				style = getComputedStyle(control);
			return 'none' !== style.display && 'hidden' !== style.visibility && box.width > 0 && box.height > 0;
		});
		const box = element.getBoundingClientRect();
		return {
			actions: controls.map(control => control.dataset.action),
			controls: controls.map(control => {
				const rect = control.getBoundingClientRect();
				return { width: rect.width, height: rect.height, top: rect.top };
			}),
			height: box.height,
			scrollHeight: element.scrollHeight,
			clipped: controls.some(control => {
				const rect = control.getBoundingClientRect();
				return rect.top < box.top - 1 || rect.bottom > box.bottom + 1;
			}),
			overflows: element.scrollWidth > element.clientWidth + 1
		};
	});

	const collapsed = await toolbarState();
	expect(collapsed.actions).toEqual(['bold', 'italic', 'ul', 'link', 'more']);
	expect(collapsed.controls.every(control => control.width >= 44 && control.height >= 44)).toBe(true);
	expect(new Set(collapsed.controls.map(control => Math.round(control.top))).size).toBe(1);
	expect(collapsed.height).toBeLessThanOrEqual(56);
	expect(collapsed.clipped).toBe(false);
	expect(collapsed.overflows).toBe(false);

	await compose.screenshot({
		path: path.join(screenshotDir, `mobile-compose-toolbar-${screenshotHost}-collapsed.png`)
	});

	const more = toolbar.locator('[data-action="more"]');
	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	const expanded = await toolbarState();
	expect(expanded.actions.length).toBeGreaterThan(20);
	expect(expanded.height).toBeGreaterThan(collapsed.height);
	expect(expanded.scrollHeight).toBeLessThanOrEqual(expanded.height + 1);
	expect(expanded.clipped).toBe(false);
	console.log(JSON.stringify({ host: screenshotHost, collapsed, expanded }));

	await compose.screenshot({
		path: path.join(screenshotDir, `mobile-compose-toolbar-${screenshotHost}-expanded.png`)
	});

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	const collapsedAgain = await toolbarState();
	expect(collapsedAgain.actions).toEqual(collapsed.actions);
	expect(collapsedAgain.height).toBe(collapsed.height);

	await more.click();
	await compose.evaluate(element => ko.dataFor(element).close());
	await expect(compose).toBeHidden();
	await page.locator('#V-MailMessageList .buttonCompose').first().click();
	await expect(compose).toBeVisible({ timeout: 10000 });
	await waitForDialogSettled(compose);
	await expect(more).toHaveAttribute('aria-expanded', 'false');
});

test('mobile rich text toolbar applies its common actions by touch', async ({ browser }) => {
	test.setTimeout(90000);
	const context = await browser.newContext({
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 }
	});
	const page = await context.newPage();
	try {
		await login(page);
		await expect(page.locator('#V-MailMessageList .buttonCompose').first()).toBeVisible({ timeout: 30000 });
		await page.locator('#V-MailMessageList .buttonCompose').first().tap();
		const compose = page.locator('#V-PopupsCompose'),
			toolbar = compose.locator('.squire-toolbar'),
				editor = compose.locator('.squire-wysiwyg');
		await expect(compose).toBeVisible({ timeout: 10000 });
		await waitForDialogSettled(compose);

		const selectText = async text => {
			await compose.evaluate((element, value) =>
				ko.dataFor(element).editor(htmlEditor => htmlEditor.setHtml(value))
			, text);
			await editor.focus();
			await editor.selectText();
			expect(await page.evaluate(() => getSelection().toString())).toBe(text);
		};

		await selectText('Bold');
		await toolbar.locator('[data-action="bold"]').tap();
		await expect(editor.locator('b')).toHaveText('Bold');

		await selectText('Italic');
		await toolbar.locator('[data-action="italic"]').tap();
		await expect(editor.locator('i')).toHaveText('Italic');

		await selectText('Bulleted');
		await toolbar.locator('[data-action="ul"]').tap();
		await expect(editor.locator('ul > li')).toHaveText('Bulleted');

		await selectText('Linked');
		page.once('dialog', dialog => dialog.accept('https://example.com/'));
		await toolbar.locator('[data-action="link"]').tap();
		await expect(editor.locator('a[href="https://example.com/"]')).toHaveText('Linked');

		await compose.evaluate(element =>
			ko.dataFor(element).editor(htmlEditor => htmlEditor.setHtml(''))
		);
		await editor.focus();
		expect(await editor.evaluate(element => element.innerHTML)).toBe('<div><br></div>');
		await toolbar.locator('[data-action="bold"]').tap();
		await expect(toolbar.locator('[data-action="bold"]')).toHaveAttribute('aria-pressed', 'true');
		await page.keyboard.type('Bold from blank');
		await expect(editor.locator('b')).toHaveText('Bold from blank');

		await compose.evaluate(element =>
			ko.dataFor(element).editor(htmlEditor => htmlEditor.setHtml(''))
		);
		await editor.focus();
		await toolbar.locator('[data-action="italic"]').tap();
		await expect(toolbar.locator('[data-action="italic"]')).toHaveAttribute('aria-pressed', 'true');
		await page.keyboard.type('Italic from blank');
		await expect(editor.locator('i')).toHaveText('Italic from blank');

		await compose.evaluate(element =>
			ko.dataFor(element).editor(htmlEditor => htmlEditor.setHtml(''))
		);
		await editor.focus();
		await toolbar.locator('[data-action="ul"]').tap();
		await expect(toolbar.locator('[data-action="ul"]')).toHaveAttribute('aria-pressed', 'true');
		await page.keyboard.type('First bulleted item');
		await expect(editor.locator('ul > li')).toHaveText('First bulleted item');

		await toolbar.locator('[data-action="more"]').tap();
		await expect(toolbar.locator('[data-action="more"]')).toHaveText(/Done/);

		await compose.evaluate(element =>
			ko.dataFor(element).editor(htmlEditor => htmlEditor.setHtml(''))
		);
		await editor.focus();
		await toolbar.locator('[data-action="ol"]').tap();
		await expect(toolbar.locator('[data-action="ol"]')).toHaveAttribute('aria-pressed', 'true');
		await page.keyboard.type('First numbered item');
		await expect(editor.locator('ol > li')).toHaveText('First numbered item');

		await selectText('Underlined');
		await toolbar.locator('[data-action="underline"]').tap();
		await expect(editor.locator('u')).toHaveText('Underlined');
	} finally {
		await context.close();
	}
});

test('mobile mailbox and composer never side-scroll', async ({ page }) => {
	test.setTimeout(90000);
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);
	await expect(page.locator('#V-MailMessageList .buttonCompose').first()).toBeVisible({ timeout: 30000 });
	await page.locator('#V-MailMessageList .buttonCompose').first().click();
	const compose = page.locator('#V-PopupsCompose'),
		more = compose.locator('[data-action="more"]');
	await expect(compose).toBeVisible({ timeout: 10000 });
	await waitForDialogSettled(compose);

	const measure = () => page.evaluate(() => {
		const metrics = selector => {
			const element = document.querySelector(selector);
			if (!element) return null;
			const box = element.getBoundingClientRect();
			return {
				client: element.clientWidth,
				left: Math.round(box.left * 10) / 10,
				right: Math.round(box.right * 10) / 10,
				scroll: element.scrollWidth
			};
		};
		return {
			viewport: innerWidth,
			html: metrics('html'),
			body: metrics('body'),
			compose: metrics('#V-PopupsCompose'),
			modalBody: metrics('#V-PopupsCompose .modal-body'),
			header: metrics('#V-PopupsCompose .b-header'),
			headerTable: metrics('#V-PopupsCompose .b-header table'),
			tabs: metrics('#V-PopupsCompose .tabs'),
			toolbar: metrics('#V-PopupsCompose .squire-toolbar')
		};
	});
	const expectFit = state => {
		for (const [name, metric] of Object.entries(state)) {
			if ('viewport' === name || !metric) continue;
			expect(metric.scroll, `${name} scroll width at ${state.viewport}px`).toBeLessThanOrEqual(metric.client + 1);
			expect(metric.left, `${name} left edge at ${state.viewport}px`).toBeGreaterThanOrEqual(-1);
			expect(metric.right, `${name} right edge at ${state.viewport}px`).toBeLessThanOrEqual(state.viewport + 1);
		}
	};

	for (const width of [320, 360, 390]) {
		await page.setViewportSize({ width, height: 844 });
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const collapsed = await measure();
		console.log(JSON.stringify({ state: 'collapsed', ...collapsed }));
		expectFit(collapsed);

		await more.click();
		const expanded = await measure();
		console.log(JSON.stringify({ state: 'expanded', ...expanded }));
		expectFit(expanded);
		await more.click();
	}
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

	const compose = await openCompose(page);
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

	const compose = await openCompose(page);
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

	await expect(compose.locator('.organization-encryption-status')).toContainText('server GPG signs and encrypts');
	await expect(compose.locator('[data-i18n*="CRYPTO/SIGN"], [data-i18n*="CRYPTO/ENCRYPT"]')).toHaveCount(0);
});

test('internal GnuPG message sends to secondary account and auto-decrypts', async ({ browser }) => {
	test.setTimeout(120000);

	const subject = `GnuPG intra-company Playwright ${Date.now()}`,
		body = `Encrypted intra-company Playwright body ${Date.now()}`,
		senderContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
			sender = await senderContext.newPage();

	await login(sender);
	const compose = await openCompose(sender);

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
	await expect(sender.locator('#V-PopupsAsk')).toBeHidden();

	await compose.evaluate(element => ko.dataFor(element).sendCommand());
	await sender.waitForFunction(() => {
		const element = document.querySelector('#V-PopupsCompose');
		return !element || element.hidden || !ko.dataFor(element)?.modalVisible?.();
	}, null, {
		timeout: 90000
	});
	await senderContext.close();

	const recipientContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await recipientContext.addInitScript(() => {
		const probe = window.__pgpDecryptProbe = {
				openpgpDecryptCalls: 0,
				openpgpVerifyCalls: 0,
				gnupgDecryptCalls: 0,
				pgpVerifyCalls: 0
			},
			wrapOpenpgp = value => {
				if ((value?.decrypt || value?.verify) && !value.__snappymailDecryptProbeWrapped) {
					const originalDecrypt = value.decrypt;
					if (originalDecrypt) {
						value.decrypt = function(...args) {
							probe.openpgpDecryptCalls += 1;
							return originalDecrypt.apply(this, args);
						};
					}
					const originalVerify = value.verify;
					if (originalVerify) {
						value.verify = function(...args) {
							probe.openpgpVerifyCalls += 1;
							return originalVerify.apply(this, args);
						};
					}
					Object.defineProperty(value, '__snappymailDecryptProbeWrapped', {
						value: true
					});
				}
				return value;
			};
		let openpgpValue = window.openpgp ? wrapOpenpgp(window.openpgp) : undefined;
		Object.defineProperty(window, 'openpgp', {
			configurable: true,
			get() {
				return openpgpValue;
			},
			set(value) {
				openpgpValue = wrapOpenpgp(value);
			}
		});

		const originalFetch = window.fetch;
		window.fetch = function(resource, init = {}) {
			try {
				const body = init.body;
				const action = 'string' === typeof body
					? JSON.parse(body).Action
					: (body instanceof FormData ? body.get('Action') : '');
				if ('GnupgDecrypt' === action) {
					probe.gnupgDecryptCalls += 1;
				} else if ('PgpVerifyMessage' === action) {
					probe.pgpVerifyCalls += 1;
				}
			} catch (e) {
				// Ignore non-JSON requests.
			}
			return originalFetch.apply(this, arguments);
		};
	});

	const recipient = await recipientContext.newPage();
	await login(recipient, secondaryEmail, secondaryPassword);
	await expect(recipient.locator('#V-PopupsAsk')).toBeHidden();
	await recipient.getByText(subject, { exact: true }).first().click({ force: true });
	await recipient.waitForFunction(expected => document.body.innerText.includes(expected), body, {
		timeout: 60000
	});
	await recipient.waitForFunction(() => {
		const message = ko.dataFor(document.querySelector('#V-MailMessageView'))?.message?.();
		return true === message?.pgpSigned?.()?.success;
	}, null, {
		timeout: 60000
	});
	await expect(recipient.locator('#V-PopupsAsk')).toBeHidden();
	await expect(recipient.locator('#V-MailMessageView')).toContainText('Signature verified automatically');
	await expect(recipient.locator('#V-MailMessageView button[data-i18n="CRYPTO/DECRYPT"]:visible')).toHaveCount(0);
	await expect(recipient.locator('#V-MailMessageView button[data-i18n="CRYPTO/VERIFY"]:visible')).toHaveCount(0);

	const received = await recipient.locator('#V-MailMessageView').evaluate(element => {
		const message = ko.dataFor(element)?.message?.(),
			text = element.innerText;
		return {
			pgpDecrypted: message?.pgpDecrypted?.(),
			pgpSignedSuccess: message?.pgpSigned?.()?.success,
			hasBody: text.includes('Encrypted intra-company Playwright body'),
			hasArmor: text.includes('BEGIN PGP MESSAGE'),
			decryptProbe: window.__pgpDecryptProbe
		};
	});

	expect(received).toMatchObject({
		pgpDecrypted: true,
		pgpSignedSuccess: true,
		hasBody: true,
		hasArmor: false
	});
	expect(received.decryptProbe.openpgpDecryptCalls).toBe(0);
	expect(received.decryptProbe.openpgpVerifyCalls).toBe(0);
	expect(received.decryptProbe.gnupgDecryptCalls).toBeGreaterThan(0);
	await recipientContext.close();
});

test('security encryption summary', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);
	await page.evaluate(() => location.hash = '#/settings/security');

	const summary = page.locator('.encryption-summary');
	await expect(summary).toContainText('Ready', { timeout: 30000 });
	await expect(page.locator('details.advanced-keys')).toHaveCount(0);

	await page.screenshot({
		fullPage: true,
		path: path.join(screenshotDir, 'settings-security.png')
	});
});
