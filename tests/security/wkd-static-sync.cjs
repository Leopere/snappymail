#!/usr/bin/env node

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { publishScript, replaceTreeAtomically, staticManifest, validateDomainSource, wkdHash } = require('../../scripts/sync-wkd-static-sites.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wkd-static-sync-'));
try {
	const domain = 'example.test';
	const email = `security@${domain}`;
	const hash = wkdHash('security');
	const emailHash = crypto.createHash('sha256').update(email).digest('hex');
	fs.mkdirSync(path.join(root, 'hu'));
	fs.writeFileSync(path.join(root, 'hu', hash), 'public-key');
	fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({
		version: 1,
		algorithm: 'sha256-email-v1',
		domain,
		entries: [{ email_hash: emailHash, wkd_hash: hash }]
	}));

	const inspect = () => [{ emails: [email], uidCount: 1, canEncrypt: true, canSign: true }];
	assert.equal(validateDomainSource(root, domain, inspect).length, 1);
	assert.throws(() => validateDomainSource(root, domain, () => [{ emails: [`colin@${domain}`], uidCount: 1, canEncrypt: true, canSign: true }]), /identity/);
	assert.throws(() => validateDomainSource(root, domain, () => [{ emails: [email, `colin@${domain}`], uidCount: 2, canEncrypt: true, canSign: true }]), /identity/);
	assert.throws(() => validateDomainSource(root, domain, () => [{ emails: [email], uidCount: 2, canEncrypt: true, canSign: true }]), /identity/);
	assert.throws(() => validateDomainSource(root, domain, () => [{ emails: [email], uidCount: 1, canEncrypt: false, canSign: true }]), /capability/);
	assert.throws(() => validateDomainSource(root, domain, () => [{ emails: [email], uidCount: 1, canEncrypt: true, canSign: false }]), /capability/);
	assert.throws(() => validateDomainSource(root, domain, () => [
		{ emails: [email], uidCount: 1, canEncrypt: false, canSign: true },
		{ emails: [`colin@${domain}`], uidCount: 1, canEncrypt: true, canSign: true }
	]), /mismatch/);
	const symlink = path.join(root, 'hu', wkdHash('symlink'));
	fs.symlinkSync(path.join(root, 'hu', hash), symlink);
	assert.throws(() => validateDomainSource(root, domain, inspect), /Symlink/);
	fs.unlinkSync(symlink);
	fs.writeFileSync(path.join(root, 'hu', wkdHash('unlisted')), 'stale-key');
	assert.throws(() => validateDomainSource(root, domain, inspect), /Unlisted/);

	assert(!publishScript.includes('.gnupg'), 'Static sync must never read legacy server GnuPG homes.');
	assert(!publishScript.includes('gpg --'), 'Static sync must never generate or overwrite active WKD objects.');
	const direct = staticManifest(domain, [{ email_hash: emailHash, wkd_hash: hash }], false);
	const advanced = staticManifest(domain, [{ email_hash: emailHash, wkd_hash: hash }], true);
	assert.equal(direct.entries[0].key_url, `https://${domain}/.well-known/openpgpkey/hu/${hash}`);
	assert.equal(advanced.entries[0].key_url, `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hash}`);

	const target = path.join(root, 'atomic-target');
	fs.mkdirSync(target);
	fs.writeFileSync(path.join(target, 'old'), 'preserved');
	assert.throws(() => replaceTreeAtomically(target, staged => {
		fs.writeFileSync(path.join(staged, 'new'), 'incomplete');
		throw Error('copy failed');
	}), /copy failed/);
	assert.equal(fs.readFileSync(path.join(target, 'old'), 'utf8'), 'preserved');
	replaceTreeAtomically(target, staged => fs.writeFileSync(path.join(staged, 'new'), 'complete'));
	assert.equal(fs.readFileSync(path.join(target, 'new'), 'utf8'), 'complete');
	console.log('WKD static sync tests passed');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
