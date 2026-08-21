const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'dev/Stores/User/OpenPGP.js'), 'utf8')
	.replace(/^import .*;\n/gm, '')
	.replace('export const OpenPGPUserStore = new class {', 'const OpenPGPUserStore = new class {')
	+ '\nmodule.exports = { OpenPGPUserStore };';

const observable = initialValue => {
	let value = initialValue;
	const result = function(nextValue) {
		if (arguments.length) {
			value = nextValue;
			return result;
		}
		return value;
	};
	result.askDeleteHelper = () => result;
	return result;
};

const deferred = () => {
	let resolve;
	return { promise: new Promise(done => resolve = done), resolve };
};

const storageValues = new Map();
const storage = {
	getItem: key => storageValues.has(key) ? storageValues.get(key) : null,
	setItem: (key, value) => storageValues.set(key, value),
	removeItem: key => storageValues.delete(key)
};
const gates = new Map(['A', 'B', 'C', 'STALE'].map(key => [key, deferred()]));
const starts = [];
const keyFor = armor => ({
	isPrivate: () => false,
	getKeyID: () => ({ toHex: () => armor }),
	getFingerprint: () => 'FPR-' + armor,
	getEncryptionKey: async () => ({}),
	users: [{ userID: { email: armor.toLowerCase() + '@example.test' } }]
});
const openpgp = {
	readKey: async ({ armoredKey }) => {
		starts.push(armoredKey);
		await gates.get(armoredKey).promise;
		return keyFor(armoredKey);
	}
};
const context = {
	module: { exports: {} },
	window: { openpgp, localStorage: storage },
	openpgp,
	ko: { observable, observableArray: (initialValue = []) => observable(initialValue) },
	IDN: { toASCII: value => value },
	Remote: {},
	Passphrases: {},
	OpenPgpClientVault: {},
	showScreenPopup: () => {},
	OpenPgpKeyPopupView: {},
	baseCollator: () => ({ compare: (left, right) => left.localeCompare(right) }),
	console,
	Uint8Array,
	atob,
	Promise
};
vm.runInNewContext(source, context, { filename: 'OpenPGP.queue.js' });

const store = context.module.exports.OpenPGPUserStore;
const waitForStart = async armor => {
	for (let attempt = 0; attempt < 100; ++attempt) {
		if (starts.includes(armor)) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	throw Error('Timed out waiting for public-key import ' + armor);
};
const fingerprints = () => Array.from(store.publicKeys(), key => key.fingerprint).sort();
const persisted = () => JSON.parse(storage.getItem('openpgp-public-keys') || '[]').sort();

(async () => {
	const imports = ['A', 'B', 'C'].map(armor => store.importPublicKeys([armor]));
	await waitForStart('A');
	assert.deepEqual(starts, ['A'], 'Concurrent imports must serialize before a stale keyring snapshot is captured.');

	gates.get('A').resolve();
	await waitForStart('B');
	gates.get('B').resolve();
	await waitForStart('C');
	gates.get('C').resolve();
	await Promise.all(imports);

	assert.deepEqual(fingerprints(), ['FPR-A', 'FPR-B', 'FPR-C']);
	assert(store.hasPublicKeyForEmails(['a@example.test', 'b@example.test', 'c@example.test']),
		'Every concurrent WKD result must remain available for recipient selection.');
	assert.deepEqual(persisted(), ['A', 'B', 'C']);

	const importingStale = store.importPublicKeys(['STALE']);
	await waitForStart('STALE');
	const removingStale = store.removePublicKeysForEmail('stale@example.test');
	gates.get('STALE').resolve();
	await Promise.all([importingStale, removingStale]);

	assert(!store.publicKeys().some(key => key.for('stale@example.test')),
		'A failed fresh WKD lookup must not be undone by an earlier in-flight import.');
	assert(!persisted().includes('STALE'),
		'A removed stale WKD key must not remain in browser storage.');

	console.log('OpenPGP public-key queue checks passed');
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
