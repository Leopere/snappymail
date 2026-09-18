#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const test = path.join(root, 'tests/php/smime-self-signed.php');
const options = { cwd: root, encoding: 'utf8' };
let result = spawnSync(process.env.PHP_BINARY || 'php', [test], options);
if (result.error?.code === 'ENOENT') {
	result = spawnSync('docker', ['compose', 'exec', '-T', '-e',
		'SNAPPYMAIL_SOURCE_ROOT=/snappymail/snappymail', 'snappymail', 'php'], {
		...options, input: fs.readFileSync(test, 'utf8')
	});
}
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
