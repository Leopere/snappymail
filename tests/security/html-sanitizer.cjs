const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rollup } = require('rollup');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '../..');
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
	|| '/Applications/Chromium.app/Contents/MacOS/Chromium';

const stubs = {
	'Common/Globals': `
		export const createElement = (name, attr) => {
			const el = document.createElement(name);
			attr && Object.entries(attr).forEach(([key, value]) => el.setAttribute(key, value));
			return el;
		};
	`,
	'Common/Utils': `
		export const isArray = Array.isArray;
		export const forEachObjectEntry = (obj, fn) => Object.entries(obj).forEach(([key, value]) => fn(key, value));
		export const pInt = (value, defaultValue = 0) => {
			value = parseInt(value, 10);
			return isFinite(value) ? value : defaultValue;
		};
	`,
	'Stores/User/Settings': `
		const setting = value => () => value;
		export const SettingsUserStore = {
			allowStyles: setting(0),
			collapseBlockquotes: setting(0),
			markdown: setting(0),
			maxBlockquotesLevel: setting(0),
			removeColors: setting(0)
		};
	`
};

const bundleSanitizer = async () => {
	const entryId = '\0html-sanitizer-entry';
	const bundle = await rollup({
		input: entryId,
		plugins: [{
			name: 'html-sanitizer-test-stubs',
			resolveId(source) {
				if (source === entryId || stubs[source]) {
					return source;
				}
				return null;
			},
			load(id) {
				if (id === entryId) {
					return `
						import { cleanHtml } from ${JSON.stringify(path.join(root, 'dev/Common/Html.js'))};
						window.__cleanHtml = cleanHtml;
					`;
				}
				return stubs[id] || null;
			}
		}]
	});
	const { output } = await bundle.generate({
		format: 'iife',
		name: 'HtmlSanitizerTest'
	});
	return output[0].code;
};

const launchBrowser = () => chromium.launch({
	...(fs.existsSync(chromiumExecutable) ? { executablePath: chromiumExecutable } : {})
});

(async () => {
	const code = await bundleSanitizer();
	const browser = await launchBrowser();
	const page = await browser.newPage();

	try {
		await page.goto('about:blank');
		await page.addScriptTag({
			content: `
				window.rl = { Utils: {} };
				window.TurndownService = class { turndown(value) { return value; } };
			`
		});
		await page.addScriptTag({ content: code });
		await page.evaluate(() => {
			window.__attachments = { findByCid: () => null };
		});

		const clean = html => page.evaluate(value =>
			window.__cleanHtml(value, window.__attachments, 'security-test').html
		, html);

		for (const href of [
			'javascript:alert(1)',
			'java&#x0a;script:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'vbscript:msgbox(1)',
			'file:///etc/passwd',
			'/relative/path',
			'foo:bar'
		]) {
			const html = await clean(`<a href="${href}">blocked</a>`);
			assert(!/<a\b[^>]*\shref=/i.test(html), `${href} should not keep href: ${html}`);
			assert(html.includes('data-x-href-broken='), `${href} should be marked broken: ${html}`);
		}

		for (const href of [
			'https://example.com/path',
			'http://example.com/path',
			'mailto:security@example.com',
			'tel:+15551234567'
		]) {
			const html = await clean(`<a href="${href}">allowed</a>`);
			assert(/<a\b[^>]*\shref=/i.test(html), `${href} should keep href: ${html}`);
			assert(html.includes('rel="external nofollow noopener noreferrer"'), `${href} should set safe rel: ${html}`);
			assert(!html.includes('data-x-href-broken='), `${href} should not be marked broken: ${html}`);
		}

		const protocolRelative = await clean('<a href="//example.com/path">protocol relative</a>');
		assert(
			protocolRelative.includes('href="https://example.com/path"'),
			`protocol-relative href should be normalized to https: ${protocolRelative}`
		);
	} finally {
		await browser.close();
	}
})().catch(error => {
	console.error(error);
	process.exit(1);
});
