#!/usr/bin/env node
// Copyright © 2026 ColinKnapp.com. All rights reserved.

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const phpTest = path.join(root, 'tests/php/idn-login-normalization.php');
const userAuth = fs.readFileSync(path.join(
	root,
	'snappymail/v/0.0.0/app/libraries/RainLoop/Actions/UserAuth.php'
), 'utf8');
const php = process.env.PHP_BINARY || 'php';
const run = (command, args, options = {}) => childProcess.spawnSync(command, args, {
	cwd: root,
	encoding: 'utf8',
	...options
});
const runPhp = (extraEnvironment = {}) => {
	let result = run(php, [phpTest], {
		env: { ...process.env, ...extraEnvironment }
	});
	if (result.error?.code !== 'ENOENT') return result;

	const container = run('docker', ['compose', 'ps', '-q', 'snappymail']);
	if (container.error || !container.stdout.trim()) {
		throw Error('IDN login normalization tests need PHP CLI or a running Docker Compose SnappyMail service.');
	}
	const environmentArguments = Object.entries({
		SNAPPYMAIL_SOURCE_ROOT: '/snappymail/snappymail',
		...extraEnvironment
	}).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
	return run('docker', [
		'compose', 'exec', '-T',
		...environmentArguments,
		'snappymail', 'php'
	], { input: fs.readFileSync(phpTest, 'utf8') });
};

assert.match(
	userAuth,
	/getEmailAddressLocalPart\(\$aCredentials\['email'\]\)[\s\S]*getEmailAddressDomain\(\$aCredentials\['email'\]\)/,
	'Login must reject an empty local part or domain before domain lookup.'
);

let result = runPhp();
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
if (0 !== result.status) process.exit(result.status || 1);

result = runPhp({
	ICU_DATA: '/definitely/missing',
	SNAPPYMAIL_EXPECT_ICU_FAILURE: '1'
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
if (0 !== result.status) process.exitCode = result.status || 1;
