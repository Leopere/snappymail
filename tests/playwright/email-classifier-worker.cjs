const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '../..');
const classifierRoot = path.join(root, 'vendors/email-classifier');
const types = {
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.onnx': 'application/octet-stream'
};

const resolveFile = pathname => {
	if ('/email-classifier-v1.worker.js' === pathname) {
		return path.join(classifierRoot, 'email-classifier-v1.worker.js');
	}
	if (pathname.startsWith('/runtime/') || pathname.startsWith('/models/')) {
		const file = path.resolve(classifierRoot, 'dist', pathname.slice(1));
		return file.startsWith(path.join(classifierRoot, 'dist') + path.sep) ? file : '';
	}
	return '';
};

(async () => {
	const requests = [];
	const server = http.createServer((request, response) => {
		const pathname = new URL(request.url, 'http://localhost').pathname;
		requests.push(pathname);
		process.env.CLASSIFIER_SMOKE_DEBUG && console.log(request.method, pathname);
		if ('/' === pathname) {
			response.writeHead(200, {
				'Content-Type': 'text/html; charset=utf-8',
				'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'"
			});
			response.end('<!doctype html><meta charset="utf-8"><title>classifier smoke test</title>');
			return;
		}
		const file = resolveFile(pathname);
		if (!file || !fs.existsSync(file)) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			'Content-Type': types[path.extname(file)] || 'application/octet-stream',
			'Cache-Control': 'public, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff'
		});
		fs.createReadStream(file).pipe(response);
	});

	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address(), origin = `http://127.0.0.1:${address.port}`;
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		const externalRequests = [];
		page.on('request', request => {
			new URL(request.url()).origin === origin || externalRequests.push(request.url());
		});
		await page.goto(origin);
		const result = await page.evaluate(() => new Promise((resolve, reject) => {
			const worker = new Worker('/email-classifier-v1.worker.js', { type: 'module' });
			const timeout = setTimeout(() => reject(Error('Classifier worker timed out')), 60000);
			worker.onerror = event => reject(Error(event.message || 'Classifier worker failed'));
			worker.onmessage = event => {
				if ('error' === event.data?.type) {
					clearTimeout(timeout);
					reject(Error(event.data.message));
				} else if ('results' === event.data?.type) {
					clearTimeout(timeout);
					worker.terminate();
					resolve(event.data.results);
				}
			};
			worker.postMessage({ type: 'classify', items: [
				{ id: 'personal', text: 'Could we catch up over coffee tomorrow? It has been great talking with you.' },
				{ id: 'finance', text: 'Your electricity invoice and billing statement for this month is attached.' },
				{ id: 'security', text: 'We noticed an unusual sign-in. Review your account security activity.' },
				{ id: 'contract', text: 'Please review and sign the attached employment agreement.' }
			] });
		}));
		process.env.CLASSIFIER_SMOKE_DEBUG && console.log(result);

		assert.deepStrictEqual(result.map(item => item.id), ['personal', 'finance', 'security', 'contract']);
		for (const item of result) {
			assert.strictEqual(item.category, item.id, `semantic classifier mislabeled ${item.id}`);
			assert.ok(item.confidence >= .56 && item.confidence <= .94);
			assert.strictEqual(item.source, 'minilm');
		}
		assert.deepStrictEqual(externalRequests, [], 'classifier made an external browser request');
		assert.ok(requests.some(request => request.endsWith('model_quantized.onnx')), 'quantized model was not loaded');
		assert.ok(requests.some(request => request.endsWith('.wasm')), 'local WASM runtime was not loaded');
		console.log(`Local MiniLM worker smoke test passed (${requests.length} same-origin requests)`);
	} finally {
		await browser.close();
		await new Promise(resolve => server.close(resolve));
	}
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
