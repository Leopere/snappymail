#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'vendors/email-classifier/dist');
const modelRevision = '4b544e74dfc3256b2b56849ea5d7064fee1ac846';

const assets = [
	{
		path: 'runtime/transformers.min.js',
		url: 'https://unpkg.com/@xenova/transformers@2.17.2/dist/transformers.min.js',
		bytes: 897938,
		sha256: 'bcf7cf304e51f470ed59409622b9d6ffbad80dfcf5baf6a40c919e4b9c4ff812'
	},
	{
		path: 'runtime/ort-wasm-simd.wasm',
		url: 'https://unpkg.com/@xenova/transformers@2.17.2/dist/ort-wasm-simd.wasm',
		bytes: 10014674,
		sha256: '9bd07bababc65f53d061f457233eeae501be7ceb8a2adb9eef52d87fe776d865'
	},
	{
		path: 'models/minilm-l3/config.json',
		url: `https://huggingface.co/Xenova/paraphrase-MiniLM-L3-v2/resolve/${modelRevision}/config.json?download=true`,
		bytes: 657,
		sha256: 'c8bcaca23b245d64047ee04fa2edcc55867064b67cbbe2772f660cdbdfb1978c'
	},
	{
		path: 'models/minilm-l3/tokenizer.json',
		url: `https://huggingface.co/Xenova/paraphrase-MiniLM-L3-v2/resolve/${modelRevision}/tokenizer.json?download=true`,
		bytes: 711649,
		sha256: '2fc687b11de0bc1b3d8348f92e3b49ef1089a621506c7661fbf3248fcd54947e'
	},
	{
		path: 'models/minilm-l3/tokenizer_config.json',
		url: `https://huggingface.co/Xenova/paraphrase-MiniLM-L3-v2/resolve/${modelRevision}/tokenizer_config.json?download=true`,
		bytes: 366,
		sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3'
	},
	{
		path: 'models/minilm-l3/onnx/model_quantized.onnx',
		url: `https://huggingface.co/Xenova/paraphrase-MiniLM-L3-v2/resolve/${modelRevision}/onnx/model_quantized.onnx?download=true`,
		bytes: 17452106,
		sha256: 'b190f50dd46296b9895ae8f274c3455762d08610f8788f4a9bd15019f4f7160c'
	}
];

const digest = data => crypto.createHash('sha256').update(data).digest('hex');

const validFile = asset => {
	try {
		const file = path.join(destination, asset.path), stat = fs.statSync(file);
		return stat.size === asset.bytes && digest(fs.readFileSync(file)) === asset.sha256;
	} catch (error) {
		return false;
	}
};

const download = (url, redirects = 0) => new Promise((resolve, reject) => {
	if (5 < redirects) {
		reject(Error(`Too many redirects while downloading ${url}`));
		return;
	}
	const client = url.startsWith('https:') ? https : http;
	client.get(url, { headers: { 'User-Agent': 'snappymail-classifier-build/1' } }, response => {
		if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
			response.resume();
			resolve(download(new URL(response.headers.location, url).href, redirects + 1));
			return;
		}
		if (200 !== response.statusCode) {
			response.resume();
			reject(Error(`Unable to download ${url}: HTTP ${response.statusCode}`));
			return;
		}
		const chunks = [];
		response.on('data', chunk => chunks.push(chunk));
		response.on('end', () => resolve(Buffer.concat(chunks)));
	}).on('error', reject);
});

const ensureAsset = async asset => {
	if (validFile(asset)) {
		return false;
	}
	const data = await download(asset.url);
	if (asset.bytes !== data.length || asset.sha256 !== digest(data)) {
		throw Error(`Classifier asset integrity check failed: ${asset.path}`);
	}
	const file = path.join(destination, asset.path);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
	return true;
};

async function ensureClassifierAssets() {
	const expected = new Set(assets.map(asset => path.join(destination, asset.path)));
	if (fs.existsSync(destination)) {
		const visit = directory => fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
			const file = path.join(directory, entry.name);
			entry.isDirectory() ? visit(file) : expected.has(file) || fs.unlinkSync(file);
		});
		visit(destination);
	}
	const changed = await Promise.all(assets.map(ensureAsset));
	return changed.filter(Boolean).length;
}

module.exports = { assets, destination, ensureClassifierAssets };

if (require.main === module) {
	ensureClassifierAssets().then(count => {
		console.log(count ? `Downloaded ${count} verified classifier assets` : 'Classifier assets already verified');
	}).catch(error => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
