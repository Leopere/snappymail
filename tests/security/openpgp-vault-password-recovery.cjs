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

const email = 'recovery@example.test';
const payload = {
	version: 1,
	activeFingerprint: 'RECOVERY-FINGERPRINT',
	privateKeys: [{ armor: 'PRIVATE-ARMOR', passphrase: 'INTERNAL-PASSPHRASE' }]
};
const oldVault = {
	version: 2,
	payload: { name: 'AES-256-GCM', iv: 'old-iv', ciphertext: 'unchanged-payload' },
	wrappers: { password: { wrapper: 'old' } }
};
const newVault = {
	version: 2,
	payload: oldVault.payload,
	wrappers: { password: { wrapper: 'current' } }
};
const record = {
	version: 2,
	revision: 7,
	status: 'quarantined',
	vault: oldVault,
	publicKey: 'PUBLIC-KEY'
};

const savedRecord = () => ({
	...record,
	revision: 8,
	status: 'active',
	vault: newVault,
	published: true,
	quarantined: false
});
let remoteResult = { valid: false, signInRequired: true }, loadFails = false, remoteErrorsRemaining = 0;
const calls = {
	remote: [],
	changePassword: 0,
	persist: 0,
	remember: 0,
	load: 0,
	validate: 0,
	unlockedKeys: []
};
const vaultKey = () => {
	const key = new Uint8Array(32).fill(7);
	calls.unlockedKeys.push(key);
	return key;
};
const OpenPgpClientVault = {
	validate: vault => vault,
	unlockWithPassword: async (mailbox, vault, password) => {
		assert.equal(mailbox, email);
		if (vault === oldVault && 'previous-password' === password) {
			return { payload, vaultKey: vaultKey(), unlockedWith: 'password' };
		}
		if (vault === newVault && 'current-password' === password) {
			return { payload, vaultKey: vaultKey(), unlockedWith: 'password' };
		}
		throw Error('Password wrapper rejected');
	},
	changePassword: async (mailbox, vault, key, password) => {
		assert.equal(mailbox, email);
		assert.equal(vault, oldVault);
		assert.equal(password, 'current-password');
		assert(key.some(value => 0 !== value), 'The recovered vault key must remain live until persistence.');
		calls.changePassword++;
		return newVault;
	},
	rememberOnDevice: async (mailbox, key) => {
		assert.equal(mailbox, email);
		assert(key.some(value => 0 !== value));
		calls.remember++;
		return true;
	}
};
const Remote = {
	post: async (action, callback, params) => {
		calls.remote.push({ action, params });
		'PgpClientVaultPasswordPut' === action && calls.persist++;
		if (0 < remoteErrorsRemaining) {
			remoteErrorsRemaining--;
			throw Error('Interrupted server response');
		}
		return { Result: remoteResult };
	}
};
const openpgp = {
	readKey: async ({ armoredKey }) => {
		assert.equal(armoredKey, record.publicKey);
		return {
			users: [{ userID: { email } }],
			isPrivate: () => false,
			getEncryptionKey: async () => ({}),
			getSigningKey: async () => ({}),
			getFingerprint: () => payload.activeFingerprint
		};
	}
};
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const context = {
	module: { exports: {} },
	window: { openpgp, localStorage: storage },
	openpgp,
	ko: { observable, observableArray: (initialValue = []) => observable(initialValue) },
	IDN: { toASCII: value => value },
	Remote,
	Passphrases: { clearAll: () => {} },
	OpenPgpClientVault,
	showScreenPopup: () => {},
	OpenPgpKeyPopupView: {},
	createLegacyTransport: () => {},
	migrateLegacyExport: () => {},
	baseCollator: () => ({ compare: (left, right) => left.localeCompare(right) }),
	console,
	Uint8Array,
	atob,
	Promise
};
vm.runInNewContext(source, context, { filename: 'OpenPGP.password-recovery.js' });

const store = context.module.exports.OpenPGPUserStore;
store.vaultEmail = email;
store.vaultRecord(record);
store.validateVaultPayload = async (candidatePayload, publicKey) => {
	assert.equal(candidatePayload, payload);
	assert.equal(publicKey, record.publicKey);
	calls.validate++;
	return [];
};
store.loadVaultPayload = async (candidatePayload, key, publicKey) => {
	assert.equal(candidatePayload, payload);
	assert(key.some(value => 0 !== value));
	assert.equal(publicKey, record.publicKey);
	calls.load++;
	if (loadFails) throw Error('Local key load failed after commit');
	return ['private-key-model'];
};

(async () => {
	await assert.rejects(
		store.recoverVaultPassword('wrong-password', 'current-password'),
		error => 'previous-password' === error.openPgpVaultRecovery
	);
	assert.equal(calls.remote.length, 0, 'A wrong previous password must not reach the server.');
	assert.equal(calls.persist, 0);

	await assert.rejects(
		store.recoverVaultPassword('previous-password', 'current-password'),
		error => 'current-password' === error.openPgpVaultRecovery
	);
	assert.equal(calls.remote.length, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(calls.remote[0])), {
		action: 'PgpClientVaultPasswordPut',
		params: {
			Password: 'current-password',
			passwordWrapper: '{"wrapper":"current"}',
			expectedRevision: 7
		}
	});
	assert.equal(calls.persist, 1, 'The password proof and wrapper mutation must use one bound request.');
	assert(calls.unlockedKeys[0].every(value => 0 === value),
		'A failed recovery must clear the locally unwrapped vault key.');
	assert(calls.unlockedKeys[1].every(value => 0 === value),
		'A failed recovery must clear the wrapper-verification key.');
	assert.equal(payload.privateKeys[0].armor, '');
	assert.equal(payload.privateKeys[0].passphrase, '');

	payload.privateKeys[0].armor = 'PRIVATE-ARMOR';
	payload.privateKeys[0].passphrase = 'INTERNAL-PASSPHRASE';
	store.vaultRecord(record);
	remoteResult = { valid: false, unavailable: true };
	await assert.rejects(
		store.recoverVaultPassword('previous-password', 'current-password'),
		error => 'current-unavailable' === error.openPgpVaultRecovery
	);
	assert.equal(calls.persist, 2);
	assert.equal(calls.remember, 0);

	payload.privateKeys[0].armor = 'PRIVATE-ARMOR';
	payload.privateKeys[0].passphrase = 'INTERNAL-PASSPHRASE';
	store.vaultRecord(record);
	remoteErrorsRemaining = 2;
	await assert.rejects(
		store.recoverVaultPassword('previous-password', 'current-password'),
		error => 'uncertain' === error.openPgpVaultRecovery
	);
	assert.equal(calls.persist, 4, 'An interrupted mutation must retry exactly once.');
	assert.equal(calls.remember, 1,
		'An uncertain response must preserve the same vault key in this browser before clearing memory.');

	payload.privateKeys[0].armor = 'PRIVATE-ARMOR';
	payload.privateKeys[0].passphrase = 'INTERNAL-PASSPHRASE';
	store.vaultRecord(record);
	remoteResult = savedRecord();
	loadFails = true;
	await assert.rejects(
		store.recoverVaultPassword('previous-password', 'current-password'),
		error => 'local-load' === error.openPgpVaultRecovery
	);
	assert.equal(store.vaultRecord().revision, 8, 'A post-commit failure must retain the saved revision.');
	assert.equal(store.vaultState(), 'locked');
	assert.match(store.vaultError(), /was updated/);

	payload.privateKeys[0].armor = 'PRIVATE-ARMOR';
	payload.privateKeys[0].passphrase = 'INTERNAL-PASSPHRASE';
	store.vaultRecord(record);
	loadFails = false;
	const privateKeys = await store.recoverVaultPassword('previous-password', 'current-password');
	assert.deepEqual(privateKeys, ['private-key-model']);
	assert.equal(calls.changePassword, 5);
	assert.equal(calls.persist, 6);
	assert.equal(calls.remember, 3);
	assert.equal(calls.load, 2);
	assert.equal(store.vaultRecord().revision, 8);
	assert(calls.unlockedKeys.at(-1).every(value => 0 === value),
		'The verification-only copy of the rewrapped vault key must be cleared.');
	assert(calls.unlockedKeys.at(-2).some(value => 0 !== value),
		'The active recovered vault key must remain available after success.');

	console.log('OpenPGP vault password recovery orchestration checks passed');
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
