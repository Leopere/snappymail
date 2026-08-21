#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const test = path.join(root, 'tests/php/openpgp-vault-lifecycle.php');
const php = process.env.PHP_BINARY || 'php';
const run = (command, args, options = {}) => childProcess.spawnSync(command, args, {
	cwd: root,
	encoding: 'utf8',
	...options
});

let result = run(php, [test]);
if (result.error?.code === 'ENOENT') {
	const container = run('docker', ['compose', 'ps', '-q', 'snappymail']);
	if (container.error || !container.stdout.trim()) {
		throw Error('OpenPGP vault lifecycle tests need PHP CLI or a running Docker Compose SnappyMail service.');
	}
	result = run('docker', [
		'compose', 'exec', '-T',
		'-e', 'SNAPPYMAIL_SOURCE_ROOT=/snappymail/snappymail',
		'snappymail', 'php'
	], { input: fs.readFileSync(test, 'utf8') });
}
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
if (0 !== result.status) process.exitCode = result.status || 1;
