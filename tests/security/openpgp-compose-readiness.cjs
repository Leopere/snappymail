const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'dev/App/User.js'), 'utf8');
const model = fs.readFileSync(path.join(root, 'dev/Model/Message.js'), 'utf8');
const composerMethod = app.slice(app.indexOf('\tshowMessageComposer(params = [])'),
	app.indexOf('\n}\n\nAskPopupView.password'));
const decryptMethod = model.slice(model.indexOf('\tasync decrypt() {'),
	model.indexOf('\n/*\n\tasync decrypted()'));
assert(composerMethod && decryptMethod, 'Exercise the production composer and decrypt methods.');

const armor = '-----BEGIN PGP MESSAGE-----\nciphertext\n-----END PGP MESSAGE-----';
const observable = initial => {
	let value = initial;
	return (...args) => args.length ? (value = args[0]) : value;
};
const deferred = () => {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
};

function setup(options = {}) {
	const calls = { ready: 0, pgp: 0, smime: 0, opened: [], errors: [] };
	const pgp = {
		isEncrypted: text => (text || '').trim().startsWith('-----BEGIN PGP MESSAGE-----'),
		hasEncryptedArmor: text => (text || '').includes('-----BEGIN PGP MESSAGE-----'),
		ready: async () => { ++calls.ready; return options.ready ?? false; }
	};
	const context = {
		ComposeType: { ForwardAsAttachment: 'attachment' },
		ComposePopupView: {},
		arrayLength: value => value?.length || 0,
		PgpUserStore: pgp,
		showScreenPopup: (view, params) => calls.opened.push({ params, body: message.plain() }),
		alert: text => calls.errors.push(text),
		i18n: (key, args) => args.ERROR
	};
	const message = {
		plain: observable(options.plain ?? 'Readable original body'),
		html: observable(options.html ?? ''),
		pgpEncrypted: observable(options.encrypted ? {} : null),
		pgpDecrypted: observable(!!options.decrypted),
		smimeEncrypted: observable(!!options.smime),
		smimeDecrypted: observable(false),
		async pgpDecrypt() {
			++calls.pgp;
			if (options.decryptWait) { await options.decryptWait; }
			if (options.throwDecrypt) { throw Error('Decryption failed'); }
			if (options.decryptFails) { return; }
			this.plain('Decrypted original body');
			this.pgpDecrypted(true);
		},
		async smimeDecrypt() {
			++calls.smime;
			this.smimeDecrypted(!options.decryptFails);
		}
	};
	message.decrypt = vm.runInNewContext('({' + decryptMethod + '})', context).decrypt;
	const appInstance = vm.runInNewContext('({' + composerMethod + '})', context);
	return { calls, message, appInstance };
}

(async () => {
	for (const mode of ['reply', 'reply-all', 'forward']) {
		for (const decrypted of [false, true]) {
			const { calls, message, appInstance } = setup({ encrypted: decrypted, decrypted });
			const params = [mode, message];
			await appInstance.showMessageComposer(params);
			assert.equal(calls.ready, 0, `${mode}: readable mail must not depend on the PGP vault`);
			assert.equal(calls.pgp, 0);
			assert.equal(calls.opened.length, 1);
			assert.equal(calls.opened[0].params, params);
			assert.equal(calls.opened[0].body, 'Readable original body');
			assert.deepEqual(calls.errors, []);
		}
		for (const encrypted of [false, true]) {
			const vault = deferred(), decrypt = deferred();
			const { calls, message, appInstance } = setup({
				encrypted, plain: armor, ready: vault.promise, decryptWait: decrypt.promise
			});
			const pending = appInstance.showMessageComposer([mode, [message]]);
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(calls.ready, 1);
			assert.equal(calls.pgp, 0, 'Wait for the vault before decrypting');
			assert.equal(calls.opened.length, 0);
			vault.resolve(true);
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(calls.pgp, 1);
			assert.equal(calls.opened.length, 0, 'Wait for actual plaintext before composing');
			decrypt.resolve();
			await pending;
			assert.equal(calls.opened.length, 1);
			assert.equal(calls.opened[0].body, 'Decrypted original body');
			assert.deepEqual(calls.errors, []);
		}
		for (const options of [
			{ encrypted: true, plain: armor },
			{ encrypted: true, plain: armor, ready: true, decryptFails: true },
			{ encrypted: true, plain: armor, ready: true, throwDecrypt: true },
			{ encrypted: true, decrypted: true, plain: armor },
			{ encrypted: true, decrypted: true, html: armor },
			{ smime: true, decryptFails: true }
		]) {
			const { calls, message, appInstance } = setup(options);
			await appInstance.showMessageComposer([mode, message]);
			assert.equal(calls.opened.length, 0, `${mode}: never compose unresolved ciphertext`);
			assert.equal(calls.errors.length, 1);
			assert(!calls.errors[0].includes('cannot be forwarded'), 'Errors must also apply to replies');
		}
		const { calls, message, appInstance } = setup({ smime: true });
		await appInstance.showMessageComposer([mode, message]);
		assert.equal(calls.ready, 0, 'S/MIME must not depend on an OpenPGP vault');
		assert.equal(calls.smime, 1);
		assert.equal(calls.opened.length, 1);
	}
	const { calls, message, appInstance } = setup({ encrypted: true, plain: armor });
	await appInstance.showMessageComposer(['attachment', message]);
	assert.equal(calls.ready, 0);
	assert.equal(calls.opened.length, 1, 'Forward as attachment preserves the original');
	await appInstance.showMessageComposer([]);
	assert.equal(calls.opened.length, 2, 'New compose needs no source message or vault');
	console.log('Reply, reply-all and forward decryption readiness checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
