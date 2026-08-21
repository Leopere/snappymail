const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assets: classifierAssets } = require('../../scripts/fetch-email-classifier-assets.cjs');

const root = path.resolve(__dirname, '../..');
const bundles = [
	'snappymail/v/0.0.0/static/js/min/boot.min.js',
	'snappymail/v/0.0.0/static/js/min/libs.min.js',
	'snappymail/v/0.0.0/static/js/min/app.min.js',
	'snappymail/v/0.0.0/static/js/min/openpgp.min.js'
].map(file => path.join(root, file));
const exists = file => {
	try {
		return fs.statSync(file).size > 0;
	} catch (error) {
		return false;
	}
};
const existingBundles = bundles.filter(exists);
const classifierFiles = classifierAssets.map(asset => ({
	...asset,
	file: path.join(root, 'snappymail/v/0.0.0/static/classifier-v1', asset.path)
})),
	classifierLicenseFiles = [
		'Apache-2.0.txt',
		'MIT-ONNX-Runtime.txt',
		'MIT-Hugging-Face-Jinja.txt'
	].map(file => path.join(root, 'snappymail/v/0.0.0/static/classifier-v1/licenses', file));
const missing = new Set();
const missingSince = new Map();
const checkContinuity = () => {
	for (const file of existingBundles) {
		if (exists(file)) {
			missingSince.delete(file);
		} else {
			const since = missingSince.get(file) || Date.now();
			missingSince.set(file, since);
			if (100 <= Date.now() - since) {
				missing.add(path.relative(root, file));
			}
		}
	}
};

const build = childProcess.spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
	cwd: root,
	stdio: 'inherit'
});
const interval = setInterval(checkContinuity, 10);
build.once('error', error => {
	clearInterval(interval);
	throw error;
});
build.once('close', code => {
	clearInterval(interval);
	checkContinuity();
	for (const file of bundles) {
		if (!exists(file)) {
			missing.add(path.relative(root, file));
		}
	}
	if (missing.size) {
		console.error('Static browser bundle disappeared or was empty during build:', [...missing].join(', '));
		process.exitCode = 1;
		return;
	}
	if (code) {
		process.exitCode = code;
		return;
	}
	for (const asset of classifierFiles) {
		if (!exists(asset.file)) {
			console.error('Classifier build asset is missing:', path.relative(root, asset.file));
			process.exitCode = 1;
			return;
		}
		const contents = fs.readFileSync(asset.file);
		if (asset.bytes !== contents.length
		 || asset.sha256 !== crypto.createHash('sha256').update(contents).digest('hex')) {
			console.error('Classifier build asset failed integrity validation:', path.relative(root, asset.file));
			process.exitCode = 1;
			return;
		}
	}
	for (const file of classifierLicenseFiles) {
		if (!exists(file)) {
			console.error('Classifier license is missing from the build:', path.relative(root, file));
			process.exitCode = 1;
			return;
		}
	}
	const wasm = fs.readFileSync(classifierFiles.find(asset => asset.path.endsWith('.wasm')).file);
	if ('0061736d' !== wasm.subarray(0, 4).toString('hex')) {
		console.error('Classifier WASM header is invalid');
		process.exitCode = 1;
		return;
	}
	console.log('Static browser bundle continuity checks passed');
});
