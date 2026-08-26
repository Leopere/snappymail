#!/usr/bin/env node
// Copyright © 2026 ColinKnapp.com. All rights reserved.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../..'),
	read = file => fs.readFileSync(path.join(root, file), 'utf8'),
	script = path.join(root, 'deploy/mail-retention/nixc-mail-retention'),
	timer = read('deploy/mail-retention/nixc-mail-retention.timer'),
	service = read('deploy/mail-retention/nixc-mail-retention.service'),
	docs = read('docs/auth-mail-retention.md'),
	temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'snappymail-retention-')),
	users = path.join(temporary, 'users'),
	log = path.join(temporary, 'doveadm.log'),
	fakeDoveadm = path.join(temporary, 'doveadm');

try {
	fs.writeFileSync(users, 'gmailarchive@nixc.us\n');
	fs.writeFileSync(fakeDoveadm, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
	fs.chmodSync(fakeDoveadm, 0o755);
	const result = spawnSync('bash', [script], {
		encoding: 'utf8',
		env: {
			...process.env,
			DOVEADM_BIN: fakeDoveadm,
			MAIL_RETENTION_USERS_FILE: users
		}
	});
	assert.equal(result.status, 0, result.stderr);
	const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
	assert.equal(calls.length, 8, 'two policies must cover four safe source mailbox patterns');
	assert(calls.every(call => call.startsWith('move -u gmailarchive@nixc.us Trash mailbox ')));
	assert.equal(calls.filter(call => call.includes('keyword $smret-auth-code savedbefore 1d')).length, 4);
	assert.equal(calls.filter(call => call.includes('keyword $smret-security-alert savedbefore 30d')).length, 4);
	assert(calls.every(call => !/ expunge | purge | delete /.test(` ${call} `)), 'retention must only move mail');

	fs.writeFileSync(users, 'valid@nixc.us\nnot a mailbox\n');
	const unsafe = spawnSync('bash', [script], {
		encoding: 'utf8',
		env: { ...process.env, DOVEADM_BIN: fakeDoveadm, MAIL_RETENTION_USERS_FILE: users }
	});
	assert.notEqual(unsafe.status, 0, 'unsafe account input must fail closed');
	assert.match(unsafe.stderr, /unsafe mailbox account/);
} finally {
	fs.rmSync(temporary, { recursive: true, force: true });
}

assert.match(timer, /OnCalendar=hourly/);
assert.match(timer, /Persistent=true/);
assert.match(service, /Type=oneshot/);
assert.match(service, /NoNewPrivileges=true/);
assert.match(service, /ProtectSystem=strict/);
assert.match(service, /ReadWritePaths=\/home\/user-data\/mail/,
	'the hardened service must retain access to Mail-in-a-Box mailbox storage');
assert.doesNotMatch(service, /php|password/i,
	'the Dovecot retention service must not depend on a SnappyMail session or mailbox password');
assert.match(docs, /\$smret-auth-code/);
assert.match(docs, /\$smret-security-alert/);
assert.match(docs, /gmailarchive@nixc\.us/);

console.log('Authentication-mail retention contract checks passed');
