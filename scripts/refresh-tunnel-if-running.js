#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');

const run = (command, args, options = {}) => spawnSync(command, args, {
	cwd: root,
	encoding: 'utf8',
	...options
});

const tunnelServices = [
	'tunnel-client',
	'tunnel-client-mail-nixc-us',
	'tunnel-client-openpgpkey-boompay-ca',
	'tunnel-client-openpgpkey-nixc-us'
];
const ps = run('docker', ['compose', 'ps', '-q', ...tunnelServices]);
if (ps.status || !ps.stdout.trim()) {
	process.exit(ps.status || 0);
}

console.log('[refresh-tunnel] tunnel clients are already running; leaving them untouched');
process.exit(0);
