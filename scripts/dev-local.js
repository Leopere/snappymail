#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const useTunnel = ['1', 'true', 'yes', 'on'].includes(String(process.env.SNAPPYMAIL_TUNNEL || '').toLowerCase());

const log = message => console.log(`[dev-local] ${message}`);

const run = (command, args, options = {}) => {
	log(`${command} ${args.join(' ')}`);
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: 'inherit',
		env: process.env,
		...options
	});

	if (result.status) {
		process.exit(result.status);
	}
};

run('npm', ['run', 'build']);

const composeArgs = ['compose'];
if (useTunnel) {
	composeArgs.push('--profile', 'tunnel');
}
composeArgs.push('up', '-d', '--build', 'snappymail', 'db', 'docker-mailserver');
if (useTunnel) {
	composeArgs.push('tunnel-client');
}

run('docker', composeArgs);

if (useTunnel) {
	run('docker', ['compose', '--profile', 'tunnel', 'up', '-d', '--force-recreate', 'tunnel-client']);
}

log(useTunnel
	? 'serving at http://0.0.0.0:8888 and tunneling through https://mail.nixc.us/'
	: 'serving at http://0.0.0.0:8888');

const watcher = spawn('node', ['scripts/watch-static.js'], {
	cwd: root,
	stdio: 'inherit',
	env: {
		...process.env,
		WATCH_SKIP_INITIAL: '1'
	}
});

const stop = signal => {
	watcher.kill(signal);
};

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

watcher.on('exit', code => {
	process.exit(code || 0);
});
