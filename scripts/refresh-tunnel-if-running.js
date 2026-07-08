#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');

const run = (command, args, options = {}) => spawnSync(command, args, {
	cwd: root,
	encoding: 'utf8',
	...options
});

const ps = run('docker', ['compose', 'ps', '-q', 'tunnel-client']);
if (ps.status || !ps.stdout.trim()) {
	process.exit(ps.status || 0);
}

console.log('[refresh-tunnel] recreating tunnel-client after snappymail restart');
const up = run('docker', [
	'compose',
	'--profile',
	'tunnel',
	'up',
	'-d',
	'--force-recreate',
	'tunnel-client'
], {
	stdio: 'inherit'
});

process.exit(up.status || 0);
