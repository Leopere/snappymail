#!/usr/bin/env node
// Copyright © 2026 ColinKnapp.com. All rights reserved.

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const realPython = childProcess.execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
const realTar = childProcess.execFileSync('/bin/sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
const nodeShebang = `#!${process.execPath}`;
const deploySource = path.join(root, 'scripts/deploy-production.sh');
const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";

const writeExecutable = (file, contents) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents);
	fs.chmodSync(file, 0o755);
};

function makeFixture(failure) {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'snappymail-deploy-flow-'));
	const bin = path.join(fixture, 'bin');
	const home = path.join(fixture, 'home');
	const source = path.join(fixture, 'source');
	const controller = path.join(home, '.local/share/boompay-vps-infra-l2-production-controller');
	const nixc = path.join(home, 'dev/cisl2-base');
	const log = path.join(fixture, 'calls.log');
	const socketPath = path.join(fixture, 'docker.sock');
	const imageTree = path.join(fixture, 'image-tree/static/js/min');
	fs.mkdirSync(bin, { recursive: true });
	fs.mkdirSync(path.join(controller, '.git'), { recursive: true });
	fs.mkdirSync(path.join(home, '.config/gh'), { recursive: true });
	fs.mkdirSync(path.join(home, '.config/codex'), { recursive: true });
	fs.writeFileSync(path.join(home, '.config/codex/snappymail-miab-audit-users.env'), 'fixture=1\n');
	fs.mkdirSync(path.join(home, 'dev/snappymail/node_modules'), { recursive: true });
	fs.mkdirSync(path.join(home, '.docker/cli-plugins'), { recursive: true });
	fs.mkdirSync(path.join(source, '.docker/release'), { recursive: true });
	fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
	fs.mkdirSync(path.join(source, 'tests/playwright'), { recursive: true });
	fs.mkdirSync(imageTree, { recursive: true });
	fs.writeFileSync(path.join(controller, '.env'), 'fixture\n');
	fs.copyFileSync(deploySource, path.join(source, 'scripts/deploy-production.sh'));
	fs.chmodSync(path.join(source, 'scripts/deploy-production.sh'), 0o755);
	fs.writeFileSync(path.join(source, '.docker/release/Dockerfile'), 'FROM scratch\n');
	fs.writeFileSync(path.join(source, 'tests/playwright/openpgp-send-contract.cjs'), 'fixture\n');
	for (const name of ['libs.min.js', 'app.min.js', 'openpgp.min.js']) {
		fs.writeFileSync(path.join(imageTree, name), `fixture-${name}\n`);
	}

	const append = `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`;
	writeExecutable(path.join(bin, 'gh'), `${nodeShebang}\nif (process.argv.includes('token')) process.stdout.write('fixture-token\\n');\n`);
	writeExecutable(path.join(bin, 'curl'), `${nodeShebang}\n${append}\n`);
	writeExecutable(path.join(bin, 'node'), `${nodeShebang}\nif (process.argv.includes('-e')) process.exit(0);\n${append}\n`);
	writeExecutable(path.join(bin, 'ship-it'), `${nodeShebang}\nconst fs=require('fs'); const cwd=process.cwd(); const args=process.argv.slice(2); if (args.length) { console.error('ship-it takes no arguments'); process.exit(64); } fs.appendFileSync(${JSON.stringify(log)}, 'ship-it ' + (cwd.includes('cisl2-base') ? 'nixc ' : 'boompay ') + args.join(' ') + '\\n'); if (${JSON.stringify(failure)} === 'boompay' && cwd.includes('boompay') && args.length === 0) process.exit(17); if (${JSON.stringify(failure)} === 'nixc' && cwd.includes('cisl2-base')) process.exit(23);\n`);
	writeExecutable(path.join(bin, 'docker'), `${nodeShebang}
const cp=require('child_process'); const fs=require('fs'); const args=process.argv.slice(2); const log=${JSON.stringify(log)}; fs.appendFileSync(log, 'docker ' + args.join(' ') + '\\n');
if (args[0] === 'context' && args[1] === 'show') process.stdout.write('default\\n');
else if (args[0] === 'context' && args[1] === 'inspect') process.stdout.write('unix://${JSON.stringify(socketPath)}\\n'.replace(/"/g, ''));
else if (args[0] === 'image' && args[1] === 'inspect' && args.includes('{{.Id}}')) process.stdout.write('sha256:' + 'c'.repeat(64) + '\\n');
else if (args[0] === 'image' && args[1] === 'inspect' && args.includes('{{index .Config.Labels "org.opencontainers.image.revision"}}')) process.stdout.write('b'.repeat(40) + '\\n');
else if (args[0] === 'buildx' && args[1] === 'build') { const i=args.indexOf('--metadata-file'); fs.writeFileSync(args[i+1], JSON.stringify({'containerimage.digest':'sha256:' + 'a'.repeat(64)})); }
else if (args[0] === 'run' && args.some(value => value.includes('tar -cf -'))) { const result = cp.spawnSync(${JSON.stringify(realTar)}, ['-cf','-', 'static/js/min/libs.min.js','static/js/min/app.min.js','static/js/min/openpgp.min.js'], {cwd:${JSON.stringify(path.join(fixture, 'image-tree'))}, stdio:['ignore','inherit','inherit']}); process.exit(result.status ?? 1); }
`);
	writeExecutable(path.join(bin, 'python3'), `${nodeShebang}
const cp=require('child_process'); const args=process.argv.slice(2); if (args[0] === '-c' && args[1].includes('pwd.getpwuid')) { process.stdout.write(process.env.FAKE_OPERATOR_HOME + '\\n'); process.exit(0); } const input=args[0] === '-' ? require('fs').readFileSync(0) : undefined; const child=cp.spawnSync(${JSON.stringify(realPython)}, args, {input, stdio:['pipe','pipe','inherit']}); process.stdout.write(child.stdout || ''); process.exit(child.status || 0);
`);
	writeExecutable(path.join(controller, 'scripts/set-snappymail-release.py'), `#!/bin/sh\nprintf 'boompay-bind %s\\n' "$*" >> ${shellQuote(log)}\n`);
	writeExecutable(path.join(controller, 'scripts/verify.sh'), `#!/bin/sh\nprintf 'boompay-verify\\n' >> ${shellQuote(log)}\n`);
	writeExecutable(path.join(nixc, 'scripts/set-snappymail-release.py'), `#!/bin/sh\nprintf 'nixc-bind %s\\n' "$*" >> ${shellQuote(log)}\n`);
	writeExecutable(path.join(nixc, 'scripts/deploy-a250-production.sh'), `#!/bin/sh\nprintf 'nixc-deploy %s\\n' "$*" >> ${shellQuote(log)}\n`);
	writeExecutable(path.join(home, '.docker/cli-plugins/docker-buildx'), '#!/bin/sh\nexit 0\n');
	fs.mkdirSync(path.dirname(socketPath), { recursive: true });

	return { fixture, bin, home, source, controller, nixc, log, socketPath, imageTree };
}

function runFixture(failure) {
	const fixture = makeFixture(failure);
	const server = net.createServer();
	server.listen(fixture.socketPath);
	try {
		const result = childProcess.spawnSync(fixture.source + '/scripts/deploy-production.sh', [], {
			cwd: fixture.source,
			env: {
				PATH: `${fixture.bin}:/usr/bin:/bin`,
				FAKE_OPERATOR_HOME: fixture.home,
				DEPLOY_IT_COMMIT: 'b'.repeat(40),
				DEPLOY_IT_ENVIRONMENT: 'production',
				SHIP_IT_BIN: `${fixture.bin}/ship-it`
			},
			encoding: 'utf8',
			timeout: 60000
		});
		assert(!result.error, result.error?.message);
		const calls = fs.existsSync(fixture.log)
			? fs.readFileSync(fixture.log, 'utf8').trim().split('\n').filter(Boolean)
			: [];
		const bundles = ['libs.min.js', 'app.min.js', 'openpgp.min.js'].map(name => {
			const file = path.join(fixture.source, 'snappymail/v/0.0.0/static/js/min', name);
			return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
		});
		return { ...fixture, result, calls, bundles };
	} finally {
		server.close();
		// Some managed hosts allow test fixtures but deny directory removal.
		if (!process.env.SNAPPYMAIL_KEEP_TEST_DIRS) {
			fs.rmSync(fixture.fixture, { recursive: true, force: true });
		}
	}
}

const success = runFixture(null);
assert.strictEqual(success.result.status, 0, success.result.stderr);
assert.deepStrictEqual(success.bundles, ['libs.min.js', 'app.min.js', 'openpgp.min.js'].map(name => `fixture-${name}\n`));
const successCalls = success.calls.join('\n');
const releaseBinding = ' --image ghcr.io/leopere/boompay-snappymail@sha256:' + 'a'.repeat(64) + ' --image-id sha256:' + 'c'.repeat(64) + ' --source ' + 'b'.repeat(40);
assert(successCalls.includes('boompay-bind' + releaseBinding));
assert(successCalls.includes('nixc-bind' + releaseBinding));
assert(successCalls.indexOf('boompay-bind') < successCalls.indexOf('https://mail.boompay.ca/'));
assert(successCalls.indexOf('https://mail.boompay.ca/') < successCalls.indexOf('nixc-bind'));
assert(successCalls.indexOf('nixc-bind') < successCalls.indexOf('https://mail.nixc.us/'));
assert(successCalls.indexOf('https://mail.nixc.us/') < successCalls.indexOf('openpgp-send-contract.cjs'));

for (const failure of ['boompay', 'nixc']) {
	const failed = runFixture(failure);
	assert.notStrictEqual(failed.result.status, 0, `${failure} failure unexpectedly succeeded: ${failed.result.stderr}`);
	const calls = failed.calls.join('\n');
	assert.strictEqual(failed.calls.filter(line => line.trim() === 'ship-it boompay').length, 1,
		'BoomPay shipping must execute exactly once');
	assert.strictEqual(failed.calls.filter(line => line.trim() === 'ship-it nixc').length, failure === 'nixc' ? 1 : 0,
		'nixc shipping must execute at most once, after BoomPay succeeds');
	if (failure === 'boompay') {
		assert(calls.includes('boompay-bind'), `${failure} calls: ${calls}`);
		assert(!calls.includes('nixc-bind'));
		assert(!calls.includes('https://mail.nixc.us/'));
	} else {
		assert(calls.includes('https://mail.boompay.ca/'));
		assert(calls.includes('nixc-bind'));
		assert(!calls.includes('https://mail.nixc.us/'));
		assert(!calls.includes('openpgp-send-contract.cjs'));
	}
}

console.log('Offline production deployment flow checks passed');
