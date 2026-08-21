#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const watchTargets = [
	'dev',
	'tasks',
	'snappymail/v/0.0.0/app/templates',
	'snappymail/v/0.0.0/app/libraries/RainLoop',
	'snappymail/v/0.0.0/app/libraries/snappymail/branding.php',
	'snappymail/v/0.0.0/static/brand',
	'snappymail/v/0.0.0/themes/MotherboardRepairCanada',
	'vendors/email-classifier/email-classifier-v1.worker.js',
	'vendors/email-classifier/THIRD_PARTY_NOTICES.md',
	'vendors/email-classifier/licenses',
	'scripts/fetch-email-classifier-assets.cjs',
	'gulpfile.js',
	'package.json'
];

let timer = null;
let running = false;
let queued = false;

const log = message => console.log(`[watch-static] ${message}`);

const runBuild = () => {
	if (running) {
		queued = true;
		return;
	}

	running = true;
	queued = false;
	log('running npm run build');

	const child = spawn('npm', ['run', 'build'], {
		cwd: root,
		stdio: 'inherit'
	});

	child.on('exit', code => {
		running = false;
		log(code ? `build failed with exit code ${code}` : 'build complete');
		if (queued) {
			runBuild();
		}
	});
};

const schedule = file => {
	clearTimeout(timer);
	timer = setTimeout(() => {
		log(`change detected${file ? `: ${file}` : ''}`);
		runBuild();
	}, 250);
};

const isGeneratedStatic = file => {
	const normalized = file.split(path.sep).join('/');
	return normalized.includes('/static/css/')
		|| normalized.includes('/static/js/')
		|| normalized.includes('/static/fonts/');
};

const watch = target => {
	const fullPath = path.join(root, target);
	if (!fs.existsSync(fullPath)) {
		return;
	}

	fs.watch(fullPath, { recursive: true }, (event, filename) => {
		const changed = filename ? path.join(target, filename.toString()) : target;
		if (isGeneratedStatic(changed)) {
			return;
		}
		schedule(changed);
	});
	log(`watching ${target}`);
};

watchTargets.forEach(watch);
if (!process.env.WATCH_SKIP_INITIAL) {
	runBuild();
}
