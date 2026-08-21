#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const domains = [
	{ domain: 'boompay.ca', repo: path.resolve(root, '../boompay-ca') },
	{ domain: 'nixc.us', repo: path.resolve(root, '../nixc-us') }
];
const zbase32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

const run = (cmd, args, options = {}) => execFileSync(cmd, args, {
	cwd: root,
	encoding: options.encoding ?? 'utf8',
	stdio: options.stdio || ['ignore', 'pipe', 'inherit'],
	input: options.input
});
const sh = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

const wkdHash = local => {
	const bytes = crypto.createHash('sha1').update(local.trim().toLowerCase()).digest();
	let bits = '';
	for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
	let result = '';
	for (let index = 0; index < bits.length; index += 5) {
		result += zbase32[parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
	}
	return result;
};

const inspectPublicKey = file => {
	const output = run('gpg', ['--batch', '--with-colons', '--import-options', 'show-only', '--dry-run', '--import', file]);
	const certificates = [];
	let certificate;
	for (const line of output.split('\n')) {
		const fields = line.split(':');
		if ('pub' === fields[0]) {
			certificate = { emails: [], canEncrypt: (fields[11] || '').toLowerCase().includes('e') };
			certificates.push(certificate);
			continue;
		}
		if ('sub' === fields[0] && certificate) {
			certificate.canEncrypt ||= (fields[11] || '').toLowerCase().includes('e');
			continue;
		}
		if ('uid' !== fields[0] || !certificate) continue;
		const uid = (fields[9] || '').replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
		for (const match of uid.matchAll(/[^\s<>]+@[^\s<>]+/g)) certificate.emails.push(match[0].toLowerCase());
	}
	for (const item of certificates) item.emails = [...new Set(item.emails)];
	return certificates;
};

const validateDomainSource = (sourceRoot, domain, inspector = inspectPublicKey) => {
	const manifestPath = path.join(sourceRoot, 'index.json');
	const huRoot = path.join(sourceRoot, 'hu');
	if (!fs.lstatSync(manifestPath).isFile() || fs.lstatSync(manifestPath).isSymbolicLink()
		|| !fs.lstatSync(huRoot).isDirectory() || fs.lstatSync(huRoot).isSymbolicLink()) {
		throw Error(`Unsafe WKD source layout for ${domain}`);
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	if (1 !== manifest.version || 'sha256-email-v1' !== manifest.algorithm || domain !== manifest.domain || !Array.isArray(manifest.entries)) {
		throw Error(`Invalid WKD manifest for ${domain}`);
	}
	const expected = new Set();
	for (const entry of manifest.entries) {
		if (!/^[a-f0-9]{64}$/.test(entry.email_hash || '') || !/^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/.test(entry.wkd_hash || '')) {
			throw Error(`Invalid WKD manifest entry for ${domain}`);
		}
		const file = path.join(huRoot, entry.wkd_hash);
		const object = fs.lstatSync(file);
		if (!object.isFile() || object.isSymbolicLink()) throw Error(`Unsafe WKD key object for ${domain}`);
		const certificates = inspector(file);
		const matches = certificates.filter(certificate => certificate.canEncrypt && certificate.emails.some(email => {
			const split = email.lastIndexOf('@');
			const local = email.slice(0, split);
			return split > 0 && email.slice(split + 1) === domain
				&& crypto.createHash('sha256').update(email).digest('hex') === entry.email_hash
				&& wkdHash(local) === entry.wkd_hash;
		}));
		if (1 !== certificates.length || 1 !== matches.length) throw Error(`WKD key identity or encryption capability mismatch: ${domain}/${entry.wkd_hash}`);
		expected.add(entry.wkd_hash);
	}
	const actual = fs.readdirSync(huRoot).filter(file => fs.lstatSync(path.join(huRoot, file)).isFile());
	if (fs.readdirSync(huRoot).some(file => fs.lstatSync(path.join(huRoot, file)).isSymbolicLink())) throw Error(`Symlink found in WKD source for ${domain}`);
	if (actual.some(file => !expected.has(file))) throw Error(`Unlisted WKD key object found for ${domain}`);
	return manifest.entries;
};

const replaceTreeAtomically = (targetRoot, populate) => {
	const parent = path.dirname(targetRoot);
	fs.mkdirSync(parent, { recursive: true });
	const staged = fs.mkdtempSync(path.join(parent, `.${path.basename(targetRoot)}.next-`));
	const backup = `${targetRoot}.previous-${process.pid}-${Date.now()}`;
	let movedOld = false;
	try {
		populate(staged);
		if (fs.existsSync(targetRoot)) {
			fs.renameSync(targetRoot, backup);
			movedOld = true;
		}
		fs.renameSync(staged, targetRoot);
		if (movedOld) fs.rmSync(backup, { recursive: true, force: true });
	} catch (error) {
		if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true });
		if (movedOld && !fs.existsSync(targetRoot)) fs.renameSync(backup, targetRoot);
		throw error;
	}
};

const publishScript = `
set -eu
wkd_root=/var/lib/snappymail/_data_/_default_/openpgpkey
for domain in ${domains.map(({ domain }) => sh(domain)).join(' ')}; do
	[ -d "$wkd_root/$domain/hu" ]
	[ -f "$wkd_root/$domain/index.json" ]
done
cd "$wkd_root"
tar -cf - ${domains.map(({ domain }) => sh(domain)).join(' ')}
`;

const staticManifest = (domain, entries, advanced) => ({
	version: 1,
	algorithm: 'sha256-email-v1',
	domain,
	generated_at: new Date().toISOString(),
	entries: entries.map(entry => ({
		email_hash: entry.email_hash,
		wkd_hash: entry.wkd_hash,
		key_url: advanced
			? `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${entry.wkd_hash}`
			: `https://${domain}/.well-known/openpgpkey/hu/${entry.wkd_hash}`
	}))
});

const main = () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snappymail-wkd-'));
	try {
		const archive = run('docker', ['compose', 'exec', '-T', 'snappymail', 'sh', '-lc', publishScript], { encoding: 'buffer' });
		const tar = spawnSync('tar', ['-xf', '-', '-C', tmpRoot], { input: archive, stdio: ['pipe', 'inherit', 'inherit'] });
		if (tar.status) process.exit(tar.status);

		const validated = domains.map(item => ({ ...item, sourceRoot: path.join(tmpRoot, item.domain) }));
		for (const item of validated) item.entries = validateDomainSource(item.sourceRoot, item.domain);
		for (const { domain, repo, sourceRoot, entries } of validated) {
			for (const rootName of ['.', 'docs']) {
				const targetRoot = path.join(repo, rootName, '.well-known', 'openpgpkey');
				replaceTreeAtomically(targetRoot, staged => {
					for (const relative of ['hu', `${domain}/hu`]) fs.mkdirSync(path.join(staged, relative), { recursive: true });
					fs.writeFileSync(path.join(staged, 'policy'), '');
					fs.writeFileSync(path.join(staged, domain, 'policy'), '');
					for (const { wkd_hash: file } of entries) {
						fs.copyFileSync(path.join(sourceRoot, 'hu', file), path.join(staged, 'hu', file));
						fs.copyFileSync(path.join(sourceRoot, 'hu', file), path.join(staged, domain, 'hu', file));
					}
					fs.writeFileSync(path.join(staged, 'index.json'), JSON.stringify(staticManifest(domain, entries, false), null, 2) + '\n');
					fs.writeFileSync(path.join(staged, domain, 'index.json'), JSON.stringify(staticManifest(domain, entries, true), null, 2) + '\n');
				});
			}
			console.log(`Synced validated browser-vault WKD key files for ${domain} to ${repo}`);
		}
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
};

module.exports = { inspectPublicKey, publishScript, replaceTreeAtomically, staticManifest, validateDomainSource, wkdHash };
if (require.main === module) main();
