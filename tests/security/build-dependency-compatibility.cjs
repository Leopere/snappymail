#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const fromGulp = createRequire(require.resolve('gulp-eslint'));
const linters = [
	createRequire(require.resolve('eslint')),
	createRequire(fromGulp.resolve('eslint'))
];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'snappymail-cache-compat-'));
try {
	// Both ESLint generations must round-trip their JSON-compatible cache data.
	for (const [index, fromLinter] of linters.entries()) {
		const fromEntries = createRequire(fromLinter.resolve('file-entry-cache'));
		const flatCache = fromEntries('flat-cache');
		const name = `eslint-${index}`;
		const cache = flatCache.load(name, directory);
		const value = { message: 'security update', metadata: { mtime: 123, size: 64 } };
		cache.setKey('record', value);
		cache.save(true);
		assert.deepEqual(flatCache.load(name, directory).getKey('record'), value);
		const fromCache = createRequire(fromEntries.resolve('flat-cache'));
		const flatted = fromCache('flatted');
		const cycle = { message: 'Flatted compatibility' };
		cycle.self = cycle;
		const restored = flatted.parse(flatted.stringify(cycle));
		assert.equal(restored.message, cycle.message);
		assert.equal(restored.self, restored);
	}

	// ESLint 6's Inquirer editor must still create, read, and remove its tempfile.
	const fromInquirer = createRequire(linters[1].resolve('inquirer'));
	const { ExternalEditor } = fromInquirer('external-editor');
	const fromEditor = createRequire(fromInquirer.resolve('external-editor'));
	assert.throws(() => fromEditor('tmp').tmpNameSync({
		tmpdir: directory, prefix: ['../outside']
	}), 'Non-string options must not bypass temporary-path traversal checks');
	const editor = new ExternalEditor('editor compatibility', { dir: directory });
	editor.editor = { bin: process.execPath, args: ['-e', 'process.exit(0)'] };
	try {
		assert.equal(editor.run(), 'editor compatibility');
		assert.equal(editor.lastExitStatus, 0);
	} finally {
		editor.cleanup();
	}
	assert(!fs.existsSync(editor.tempFile));
} finally {
	fs.rmSync(directory, { recursive: true, force: true });
}
console.log('Build dependency cache and editor compatibility passed');
