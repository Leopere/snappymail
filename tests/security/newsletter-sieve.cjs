#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, '.codex/skills/snappymail-smart-sorting/scripts/newsletter-sieve.mjs');
const installer = fs.readFileSync(
	path.join(root, '.codex/skills/snappymail-smart-sorting/scripts/install-newsletter-sieve.mjs'),
	'utf8'
);
const skill = fs.readFileSync(
	path.join(root, '.codex/skills/snappymail-smart-sorting/SKILL.md'),
	'utf8'
);
const original = [
	'require ["copy","fileinto"];',
	'# rule:[Existing]',
	'if header :contains "from" "existing@example.test"',
	'{',
	'\tfileinto "Smart.Development";',
	'\tstop;',
	'}',
	''
].join('\n');

const run = (args, input = '') => {
	const result = spawnSync(process.execPath, [script, ...args], {
		cwd: root,
		input,
		encoding: 'utf8'
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
};

const candidate = run(['patch', 'Smart.Newsletters'], original);
assert(candidate.startsWith('# BEGIN SNAPPYMAIL MANAGED SORTING REQUIREMENTS\nrequire ["fileinto"];'));
assert(candidate.indexOf('# rule:[Existing]') < candidate.indexOf('# BEGIN SNAPPYMAIL MANAGED NEWSLETTER SORTING'),
	'existing user rules must run before the managed default');
assert.match(candidate, /anyof\(\s*exists "List-Id",\s*exists "List-Unsubscribe"/);
assert.match(candidate, /not header :contains \["Subject"\]/);
assert.match(candidate, /fileinto "Smart\.Newsletters";\s*stop;/);

const managed = candidate.slice(candidate.indexOf('# BEGIN SNAPPYMAIL MANAGED NEWSLETTER SORTING'));
assert.doesNotMatch(managed, /\b(?:addflag|discard|redirect|reject)\b/i);
assert.equal(run(['patch', 'Smart.Newsletters'], candidate), candidate,
	'patching must be idempotent');
assert.equal(run(['remove'], candidate), original,
	'removing managed blocks must restore the original script');

const escaped = run(['render', 'Smart."Quoted"']);
assert.match(escaped, /fileinto "Smart\.\\"Quoted\\"";/);

const invalid = spawnSync(process.execPath, [script, 'render', 'Bad\nFolder'], {
	cwd: root,
	encoding: 'utf8'
});
assert.notEqual(invalid.status, 0, 'control characters in folder names must fail closed');

assert.match(installer, /compiled=\$\(mktemp\)/,
	'remote compilation must allocate a disposable output file');
assert.match(installer, /sievec "\$candidate" "\$compiled"/,
	'remote compilation must use the disposable output file');
assert.doesNotMatch(installer, /sievec[^\n]*\/dev\//,
	'device nodes must never be passed as sievec output files');
assert.match(skill, /Never pass `\/dev\/null`/,
	'the reusable workflow must explicitly prohibit /dev/null as sievec output');

console.log('Managed newsletter Sieve checks passed');
