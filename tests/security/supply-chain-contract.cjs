#!/usr/bin/env node
// Guards the September 2026 source-scan remediation: the shipping gate keeps
// scanning for secrets and fixable advisories, retired vulnerable build
// dependencies stay out of the lockfile, compiled bytecode stays untracked,
// and the media-query grouping keeps the retired plugin's ordering.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { groupMediaQueries } = require('../../tasks/group-media-queries');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const verify = read('scripts/verify.sh');
for (const fragment of [
	'trivy fs',
	'--scanners vuln,secret',
	'--severity HIGH,CRITICAL',
	'--ignore-unfixed',
	'--exit-code 1',
	'--skip-dirs node_modules'
]) {
	assert(verify.includes(fragment), `scripts/verify.sh must keep the Trivy source gate fragment ${fragment}`);
}
assert(verify.indexOf('npm run test:security') < verify.indexOf('trivy fs'),
	'The Trivy gate must run after the test suite so a failing gate is the last word before a push.');

const lockfile = read('yarn.lock');
for (const retired of [
	'image-size@',
	'decode-uri-component@',
	'source-map-resolve@',
	'gulp-group-css-media-queries@',
	'serialize-javascript@',
	'rollup-plugin-terser@'
]) {
	assert(!lockfile.includes('\n' + retired) && !lockfile.startsWith(retired),
		`yarn.lock must not reintroduce ${retired}`);
}
const manifest = JSON.parse(read('package.json'));
assert(!manifest.dependencies['gulp-group-css-media-queries'],
	'package.json must not depend on the retired gulp-group-css-media-queries plugin');
assert.equal(manifest.resolutions.less, '4.9.1', 'less must stay on a release without image-size');
assert.equal(manifest.resolutions.ajv, '6.14.0');
assert.equal(manifest.resolutions['eslint/table/ajv'], '8.18.0');
assert(Object.keys(manifest.resolutions).indexOf('eslint/table/ajv') < Object.keys(manifest.resolutions).indexOf('ajv'),
	'Yarn applies the first matching resolution, so the table-scoped ajv pin must precede the blanket pin.');

const gitignore = read('.gitignore');
assert(gitignore.includes('\n__pycache__/\n') && gitignore.includes('\n*.pyc\n'),
	'.gitignore must ignore compiled Python bytecode');
assert(read('.dockerignore').includes('**/__pycache__'), '.dockerignore must exclude compiled Python bytecode');
const tracked = childProcess.execFileSync('git', ['ls-files', '--', '*.pyc', '**/__pycache__/*'], {
	cwd: root, encoding: 'utf8'
}).trim();
assert.equal(tracked, '', 'Compiled Python bytecode must not be tracked: ' + tracked);

const grouped = groupMediaQueries([
	'a{color:red}',
	'@media (max-width: 800px){a{color:blue}}',
	'@media (min-width: 60em){a{color:green}}',
	'@media print{a{color:black}}',
	'@media (min-width: 600px) and (max-width: 900px){a{color:pink}}',
	'@media (min-width: 400px){a{color:gray}}',
	'@media (max-width: 1200px){a{color:navy}}',
	'@media (max-width: 800px){b{color:teal}}',
	'b{color:white}'
].join('\n'));
const order = [...grouped.matchAll(/@media ([^{]+)\{/g)].map(match => match[1].trim());
assert.deepEqual(order, [
	'(min-width: 400px)',
	'(min-width: 60em)',
	'(max-width: 1200px)',
	'(max-width: 800px)',
	'(min-width: 600px) and (max-width: 900px)',
	'print'
], 'Media queries must keep the retired plugin ordering: min ascending, max descending, ranges, others');
assert(grouped.indexOf('b{color:white}') < grouped.indexOf('@media'), 'Root rules must precede every grouped media block');
assert.match(grouped, /@media \(max-width: 800px\)\s*\{\s*a\{color:blue\}\s*b\{color:teal\}\s*\}/,
	'Blocks with the same query must merge in source order');
console.log('Supply-chain contract passed');
