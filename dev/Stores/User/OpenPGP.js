/**
 * OpenPGP.js browser-only key store.
 */

import ko from 'ko';

import Remote from 'Remote/User/Fetch';

import { showScreenPopup } from 'Knoin/Knoin';
import { OpenPgpKeyPopupView } from 'View/Popup/OpenPgpKey';

import { Passphrases } from 'Storage/Passphrases';
import { OpenPgpClientVault } from 'Storage/OpenPgpVault';
import { createLegacyTransport, migrateLegacyExport } from 'Storage/OpenPgpLegacyMigration';

import { baseCollator } from 'Common/Translator';

const
	loaded = () => !!window.openpgp,
	normalizeEmail = email => IDN.toASCII((email || '').trim()).toLowerCase(),
	findOpenPGPKey = (keys, query) => {
		query = normalizeEmail(query);
		return keys.find(key => key.for(query) || query === key.id || query === key.fingerprint);
	},
	decodeBase64 = value => {
		const binary = atob(value || '');
		return Uint8Array.from(binary, char => char.charCodeAt(0));
	},
	keyArmor = async key => await key.armor(),
	keyCanEncrypt = async key => {
		try {
			return !!await key.getEncryptionKey();
		} catch (error) {
			return false;
		}
	},
	validateMailboxPublicKey = async (armoredKey, email) => {
		const key = await openpgp.readKey({ armoredKey }),
			emails = [...new Set(key.users.map(user => normalizeEmail(user.userID?.email)).filter(Boolean))];
		if (key.isPrivate() || 1 !== key.users.length || 1 !== emails.length || normalizeEmail(email) !== emails[0]
			|| !await keyCanEncrypt(key)) {
			throw Error('The OpenPGP public key does not match this mailbox or cannot encrypt');
		}
		await key.getSigningKey();
		return key;
	},
	keyEncryptionId = async key => (await key.getEncryptionKey()).getKeyID().toHex().toUpperCase(),
	publicKeysItem = 'openpgp-public-keys',
	obsoletePrivateKeysItem = 'openpgp-private-keys',
	storage = window.localStorage,
	storedPublicKeys = () => {
		try {
			const value = JSON.parse(storage.getItem(publicKeysItem));
			return Array.isArray(value) ? value : [];
		} catch (error) {
			return [];
		}
	},
	loadOpenPgpPublicKeys = async () => {
		const keys = [];
		for (const armoredKey of storedPublicKeys()) try {
			const key = await openpgp.readKey({ armoredKey });
			if (!key.isPrivate()) {
				const model = new OpenPgpKeyModel(armoredKey, key);
				model.can_encrypt = await keyCanEncrypt(key);
				keys.push(model);
			}
		} catch (error) {
			console.warn('Ignoring invalid stored OpenPGP public key', error);
		}
		return keys;
	},
	storeOpenPgpPublicKeys = keys => {
		const armoredKeys = keys.map(item => item.armor);
		if (armoredKeys.length) {
			storage.setItem(publicKeysItem, JSON.stringify(armoredKeys));
		} else {
			storage.removeItem(publicKeysItem);
		}
	},
	collator = baseCollator(),
	sort = keys => keys.sort(
		(a, b) => collator.compare(a.emails[0], b.emails[0]) || collator.compare(a.id, b.id)
	),
	dedup = keys => sort((keys || [])
		.filter((value, index, values) => values.findIndex(entry => entry.fingerprint === value.fingerprint) === index)
	),
	privateKeyPayload = (armor, passphrase, fingerprint) => ({ armor, passphrase, fingerprint }),
	signatureStatuses = async result => await Promise.all((result.signatures || []).map(async signature => {
		let status = 0, error = '';
		try {
			await signature.verified;
		} catch (reason) {
			status = 1;
			error = reason?.message || 'Signature could not be verified';
		}
		return {
			fingerprint: signature.keyID?.toHex?.().toUpperCase() || '',
			status,
			error
		};
	}));

const decryptKey = async (privateKey, buttonText = 'SIGN') => {
	if (privateKey.key.isDecrypted()) {
		return privateKey.key;
	}
	let passphrase = privateKey.vaultPassphrase || Passphrases.handle(privateKey);
	if (!passphrase) {
		const pass = await Passphrases.ask(privateKey,
			'OpenPGP.js key<br>' + privateKey.id + ' ' + privateKey.emails[0],
			'CRYPTO/' + buttonText
		);
		passphrase = pass?.password || '';
		pass?.remember && Passphrases.handle(privateKey, passphrase);
	}
	if (!passphrase) {
		return null;
	}
	const key = await openpgp.decryptKey({
		privateKey: privateKey.key,
		passphrase
	});
	privateKey.key = key;
	return key;
};

class OpenPgpKeyModel {
	constructor(armor, key, vaultPassphrase = '') {
		this.key = key;
		this.id = key.getKeyID().toHex().toUpperCase();
		this.fingerprint = key.getFingerprint().toUpperCase();
		this.can_encrypt = false;
		this.can_sign = true;
		this.emails = key.users
			.map(user => normalizeEmail(user.userID?.email))
			.filter(email => email);
		this.armor = armor;
		this.vaultPassphrase = vaultPassphrase;
		this.askDelete = ko.observable(false);
		this.openForDeletion = ko.observable(null).askDeleteHelper();
	}

	for(email) {
		return this.emails.includes(normalizeEmail(email));
	}

	view() {
		showScreenPopup(OpenPgpKeyPopupView, [this]);
	}

	remove() {
		if (this.askDelete()) {
			if (this.key.isPrivate()) {
				return OpenPGPUserStore.removePrivateKey(this);
			}
			return OpenPGPUserStore.removePublicKey(this);
		}
	}
}

export const OpenPGPUserStore = new class {
	constructor() {
		this.publicKeys = ko.observableArray();
		this.privateKeys = ko.observableArray();
		this.vaultState = ko.observable('unavailable');
		this.vaultRecord = ko.observable(null);
		this.vaultError = ko.observable('');
		this.vaultEmail = '';
		this.vaultKey = null;
		this.vaultPayload = null;
		this.vaultPromise = null;
		this.vaultStartupPromise = null;
		this.publicKeyLoadPromise = Promise.resolve();
		this.publicKeyUpdatePromise = Promise.resolve();
		this.publicKeyDiscoveryPromises = new Map();
	}

	loadKeyrings(email = '', loginPassword = '', legacyMigrationCapability = '') {
		if (!loaded() || !OpenPgpClientVault.isSupported()) {
			this.vaultState('unavailable');
			return Promise.resolve(false);
		}
		if (this.vaultStartupPromise) {
			return this.vaultStartupPromise;
		}
		this.vaultEmail = normalizeEmail(email || this.vaultEmail);
		// This clean-start deployment intentionally discards unprotected legacy browser keys.
		storage.removeItem(obsoletePrivateKeysItem);
		this.privateKeys([]);
		this.vaultKey = null;
		this.vaultPayload = null;
		this.publicKeyLoadPromise = loadOpenPgpPublicKeys()
			.then(keys => {
				this.publicKeys(dedup(keys));
			});
		let startup;
		this.vaultStartupPromise = startup = this.publicKeyLoadPromise
			.then(() => this.loadVaultRecordWithRetry())
			.then(record => this.autoStartVault(loginPassword, record, legacyMigrationCapability))
			.finally(() => {
				if (this.vaultStartupPromise === startup) {
					this.vaultStartupPromise = null;
				}
			});
		return startup;
	}

	async loadVaultRecord() {
		this.vaultRecord(null);
		this.vaultError('');
		if (!this.vaultEmail) {
			this.vaultState('unavailable');
			return null;
		}
		let response;
		try {
			response = await Remote.post('PgpClientVaultGet', null, {}, 10000);
		} catch (error) {
			const failure = error instanceof Error ? error : Error('Unable to load the encrypted key vault');
			failure.openPgpVaultReadFailure = true;
			throw failure;
		}
		const
			result = response?.Result || {},
			record = result.record || null;
		if (true === result.invalid) {
			this.vaultState('error');
			this.vaultError('The existing encrypted key vault is invalid and was preserved for recovery.');
			throw Error(this.vaultError());
		}
		if (!record) {
			this.vaultState('missing');
			return null;
		}
		OpenPgpClientVault.validate(record.vault);
		await this.importPublicKeys([record.publicKey], false);
		record.published = true === result.published;
		record.quarantined = true === result.quarantined || 'quarantined' === record.status;
		this.vaultRecord(record);
		if (record.quarantined) {
			this.vaultState('quarantined');
			this.vaultError('This encryption vault is in recovery mode. '
				+ 'Its public WKD key stays withdrawn until you recover the private key.');
		}
		else if (!record.published) {
			this.vaultState('error');
			this.vaultError('The OpenPGP public key could not be published to WKD.');
		}
		else {
			this.vaultState('locked');
		}
		return record;
	}

	async loadVaultRecordWithRetry() {
		try {
			return await this.loadVaultRecord();
		} catch (error) {
			await new Promise(resolve => setTimeout(resolve, 250));
			try {
				return await this.loadVaultRecord();
			} catch (retryError) {
				console.error('OpenPGP client vault load failed', retryError);
				this.vaultState('error');
				this.vaultError('Unable to load the encrypted key vault');
				throw retryError;
			}
		}
	}

	isSupported() {
		return loaded() && OpenPgpClientVault.isSupported();
	}

	isVaultReady() {
		return 'ready' === this.vaultState();
	}

	hasVault() {
		return !!this.vaultRecord();
	}

	lock() {
		this.vaultKey?.fill(0);
		this.privateKeys().forEach(key => {
			key.vaultPassphrase = '';
			key.armor = '';
			try {
				key.key.clearPrivateParams?.();
			} catch (error) {
				console.warn('Unable to clear OpenPGP private key memory', error);
			}
		});
		this.vaultPayload?.privateKeys?.forEach(key => {
			key.armor = '';
			key.passphrase = '';
		});
		this.vaultKey = null;
		this.vaultPayload = null;
		this.privateKeys([]);
		Passphrases.clearAll();
		this.vaultRecord() && this.vaultState('locked');
	}

	queuePublicKeyUpdate(update) {
		const queued = this.publicKeyUpdatePromise.then(update);
		this.publicKeyUpdatePromise = queued.catch(() => {});
		return queued;
	}

	importPublicKeys(keys, persist = true, replaceEmail = '') {
		return this.queuePublicKeyUpdate(() => this.importPublicKeysNow(keys, persist, replaceEmail));
	}

	async importPublicKeysNow(keys, persist = true, replaceEmail = '') {
		if (!loaded()) {
			return [];
		}
		replaceEmail = normalizeEmail(replaceEmail);
		const publicKeys = this.publicKeys(), imported = [], replacementFingerprints = new Set();
		for (const armoredKey of keys || []) try {
			const key = await openpgp.readKey({ armoredKey });
			if (key.isPrivate()) {
				throw Error('Private keys must be imported into the encrypted browser vault');
			}
			const model = new OpenPgpKeyModel(armoredKey, key);
			model.can_encrypt = await keyCanEncrypt(key);
			if (!publicKeys.find(entry => entry.fingerprint === model.fingerprint)) {
				publicKeys.push(model);
				imported.push(model);
			}
			replaceEmail && model.for(replaceEmail) && replacementFingerprints.add(model.fingerprint);
		} catch (error) {
			console.warn('OpenPGP public key import failed', error);
		}
		if (replaceEmail && replacementFingerprints.size) {
			for (let index = publicKeys.length - 1; 0 <= index; --index) {
				const key = publicKeys[index];
				if (key.for(replaceEmail) && !replacementFingerprints.has(key.fingerprint)) {
					publicKeys.splice(index, 1);
				}
			}
		}
		this.publicKeys(dedup(publicKeys));
		persist && storeOpenPgpPublicKeys(this.publicKeys());
		return imported;
	}

	removePublicKeysForEmail(email) {
		email = normalizeEmail(email);
		if (!email) {
			return Promise.resolve();
		}
		return this.queuePublicKeyUpdate(() => {
			const publicKeys = this.publicKeys(),
				retained = publicKeys.filter(key => !key.for(email));
			if (retained.length !== publicKeys.length) {
				this.publicKeys(dedup(retained));
				storeOpenPgpPublicKeys(this.publicKeys());
			}
		});
	}

	removePublicKey(model) {
		return this.queuePublicKeyUpdate(() => {
			const publicKeys = this.publicKeys(),
				retained = publicKeys.filter(key => key !== model);
			if (retained.length !== publicKeys.length) {
				this.publicKeys(dedup(retained));
				storeOpenPgpPublicKeys(this.publicKeys());
			}
		});
	}

	importKey(armoredKey) {
		return this.importPublicKeys([armoredKey]);
	}

	async loadVaultPayload(payload, vaultKey, publicKey) {
		if (!payload || 1 !== payload.version || !Array.isArray(payload.privateKeys)) {
			throw Error('Invalid encrypted key vault payload');
		}
		const privateKeys = [];
		for (const entry of payload.privateKeys) {
			if (!entry || 'string' !== typeof entry.armor || 'string' !== typeof entry.passphrase) {
				throw Error('Invalid encrypted private key entry');
			}
			const key = await openpgp.readPrivateKey({ armoredKey: entry.armor }),
				model = new OpenPgpKeyModel(entry.armor, key, entry.passphrase);
			if (entry.fingerprint && entry.fingerprint.toUpperCase() !== model.fingerprint) {
				throw Error('Encrypted key fingerprint mismatch');
			}
			privateKeys.push(model);
			await this.importPublicKeys([await keyArmor(key.toPublic())], false);
		}
		if (!privateKeys.length) {
			throw Error('Encrypted key vault is empty');
		}
		const publishedKey = await validateMailboxPublicKey(publicKey, this.vaultEmail),
			activeFingerprint = (payload.activeFingerprint || '').toUpperCase(),
			activeKey = privateKeys.find(key => key.fingerprint === activeFingerprint);
		if (!activeKey || !activeKey.for(this.vaultEmail)
			|| activeKey.fingerprint !== publishedKey.getFingerprint().toUpperCase()
			|| !await keyCanEncrypt(activeKey.key)) {
			throw Error('The encrypted private key does not match the published mailbox key');
		}
		this.vaultKey = vaultKey;
		this.vaultPayload = payload;
		this.privateKeys(dedup(privateKeys));
		this.vaultState('ready');
		this.vaultError('');
		return privateKeys;
	}

	async quarantineVault(record) {
		const response = await Remote.post('PgpClientVaultQuarantine', null, {
				expectedRevision: record.revision
			}, 15000),
			quarantined = response?.Result;
		if (quarantined?.conflict) {
			throw Error('The encrypted key vault changed in another session. Reload before trying again.');
		}
		if (!quarantined || true !== quarantined.quarantined || false !== quarantined.published) {
			throw Error('The inaccessible OpenPGP public key could not be withdrawn from WKD');
		}
		this.vaultRecord(quarantined);
		this.vaultState('quarantined');
		return quarantined;
	}

	async restoreVault(record) {
		const response = await Remote.post('PgpClientVaultRestore', null, {
				expectedRevision: record.revision
			}, 15000),
			restored = response?.Result;
		if (restored?.conflict) {
			throw Error('The encrypted key vault changed in another session. Reload before trying again.');
		}
		if (!restored || true !== restored.published || true === restored.quarantined) {
			throw Error('The recovered OpenPGP public key could not be restored to WKD');
		}
		this.vaultRecord(restored);
		return restored;
	}

	async persistVault(vault, publicKey) {
		await validateMailboxPublicKey(publicKey, this.vaultEmail);
		const expectedRevision = this.vaultRecord()?.revision || 0,
			response = await Remote.post('PgpClientVaultPut', null, {
				vault: JSON.stringify(vault),
				publicKey,
				expectedRevision
			}, 15000),
			record = response?.Result;
		if (record?.conflict) {
			throw Error('The encrypted key vault changed in another session. Reload before trying again.');
		}
		if (!record || true !== record.published || !Number.isInteger(record.revision) || 0 >= record.revision
			|| 'string' !== typeof record.publicKey || record.publicKey !== publicKey) {
			throw Error('The browser encryption vault was not saved and published. Sign in again and retry.');
		}
		OpenPgpClientVault.validate(record.vault);
		this.vaultRecord(record);
		return record;
	}

	async createVault(loginPassword) {
		if (!this.vaultEmail) {
			throw Error('No mailbox is available for the encryption vault');
		}
		if (!loginPassword) {
			throw Error('Sign out and sign in again to create the browser encryption vault');
		}
		const keyPassphrase = OpenPgpClientVault.createKeyPassphrase(),
			keyPair = await openpgp.generateKey({
				type: 'ecc',
				curve: 'curve25519',
				userIDs: [{ name: '', email: this.vaultEmail }],
				passphrase: keyPassphrase
			}),
			privateKey = await openpgp.readPrivateKey({ armoredKey: keyPair.privateKey }),
			payload = {
				version: 1,
				activeFingerprint: privateKey.getFingerprint().toUpperCase(),
				privateKeys: [privateKeyPayload(
				keyPair.privateKey,
				keyPassphrase,
				privateKey.getFingerprint().toUpperCase()
			)]
		},
			created = await OpenPgpClientVault.create(this.vaultEmail, payload, loginPassword);
		await this.persistVault(created.vault, keyPair.publicKey);
		await OpenPgpClientVault.rememberOnDevice(this.vaultEmail, created.vaultKey).catch(() => false);
		return this.loadVaultPayload(payload, created.vaultKey, keyPair.publicKey);
	}

	async migrateLegacyVault(loginPassword, migrationCapability) {
		if (!migrationCapability) {
			throw Error('Sign out and sign in again to authorize legacy key migration');
		}
		const transport = await createLegacyTransport(this.vaultEmail);
		let response;
		try {
			response = await Remote.post('PgpLegacyProtectedKeyExport', null, {
				transportPublicKey: transport.publicKey,
				migrationToken: migrationCapability
			}, 30000);
			const migration = await migrateLegacyExport(
				this.vaultEmail, response?.Result, transport.privateKey
			);
			if (!migration) {
				return null;
			}
			const created = await OpenPgpClientVault.create(
				this.vaultEmail, migration.payload, loginPassword
			);
			await this.persistVault(created.vault, migration.publicKey);
			await OpenPgpClientVault.rememberOnDevice(this.vaultEmail, created.vaultKey).catch(() => false);
			return this.loadVaultPayload(migration.payload, created.vaultKey, migration.publicKey);
		} finally {
			transport.privateKey = '';
			transport.publicKey = '';
			response = null;
		}
	}

	async autoStartVault(loginPassword = '', record = this.vaultRecord(), legacyMigrationCapability = '') {
		if (!record) {
			if ('missing' !== this.vaultState()) {
				throw Error(this.vaultError() || 'Unable to load the encrypted key vault');
			}
			if (!loginPassword) {
				return null;
			}
			try {
				return await this.migrateLegacyVault(loginPassword, legacyMigrationCapability)
					|| await this.createVault(loginPassword);
			} catch (error) {
				this.vaultState('error');
				this.vaultError(error?.message || 'Unable to migrate the existing OpenPGP key');
				throw error;
			}
		}
		if (false === record.published && !record.quarantined) {
			throw Error('The OpenPGP public key could not be published to WKD.');
		}

		let unlocked = null;
		if (loginPassword) try {
			unlocked = await OpenPgpClientVault.unlockWithPassword(this.vaultEmail, record.vault, loginPassword);
		} catch (error) {
			// A password change is expected to fall back to this browser's device wrapper.
		}
		if (!unlocked) try {
			unlocked = await OpenPgpClientVault.unlockWithDevice(this.vaultEmail, record.vault);
		} catch (error) {
			if (loginPassword && !record.quarantined) {
				try {
					record = await this.quarantineVault(record);
				} catch (quarantineError) {
					this.vaultState('error');
					this.vaultError(quarantineError?.message || 'The inaccessible OpenPGP key could not be withdrawn');
					return null;
				}
			}
			this.vaultState(record.quarantined ? 'quarantined' : 'locked');
			this.vaultError(loginPassword
				? 'This vault did not unlock with the current password. '
					+ 'Its public WKD key was withdrawn to stop new unreadable mail.'
				: 'Sign in again to unlock the browser encryption vault.');
			return null;
		}

		let privateKeys;
		try {
			privateKeys = await this.loadVaultPayload(unlocked.payload, unlocked.vaultKey, record.publicKey);
		} catch (error) {
			if (!record.quarantined) {
				record = await this.quarantineVault(record);
			}
			this.lock();
			this.vaultState('quarantined');
			this.vaultError('The private key did not match its public WKD key. Publication was withdrawn.');
			return null;
		}
		await OpenPgpClientVault.rememberOnDevice(this.vaultEmail, unlocked.vaultKey).catch(() => false);
		if (loginPassword && 'password' !== unlocked.unlockedWith) {
			const vault = await OpenPgpClientVault.changePassword(
				this.vaultEmail, record.vault, this.vaultKey, loginPassword
			);
			await this.persistVault(vault, record.publicKey);
		}
		else if (record.quarantined) {
			await this.restoreVault(record);
		}
		return privateKeys;
	}

	ensureVault() {
		if (this.isVaultReady()) {
			return Promise.resolve(this.privateKeys());
		}
		if (this.vaultStartupPromise) {
			return this.vaultStartupPromise.then(privateKeys => {
				if (!privateKeys) {
					throw Error('Sign out and sign in again to unlock the browser encryption vault');
				}
				return privateKeys;
			});
		}
		if (!this.vaultRecord() && 'missing' !== this.vaultState()) {
			return Promise.reject(Error(this.vaultError() || 'Unable to load the encrypted key vault'));
		}
		if (!this.vaultPromise) {
			this.vaultPromise = this.autoStartVault()
				.then(privateKeys => {
					if (!privateKeys) {
						throw Error('Sign out and sign in again to unlock the browser encryption vault');
					}
					return privateKeys;
				})
				.catch(error => {
					this.vaultError(error?.message || 'Unable to unlock encryption vault');
					!['error', 'quarantined'].includes(this.vaultState())
						&& this.vaultState(this.vaultRecord() ? 'locked' : 'missing');
					throw error;
				})
				.finally(() => this.vaultPromise = null);
		}
		return this.vaultPromise;
	}

	async removePrivateKey(model) {
		await this.ensureVault();
		const privateKeys = this.privateKeys().filter(key => key !== model);
		if (!privateKeys.length) {
			throw Error('The active encryption key cannot be removed');
		}
		const payload = {
			...this.vaultPayload,
			activeFingerprint: this.vaultPayload.activeFingerprint === model.fingerprint
				? privateKeys[0].fingerprint : this.vaultPayload.activeFingerprint,
			privateKeys: privateKeys.map(key => privateKeyPayload(key.armor, key.vaultPassphrase, key.fingerprint))
		};
		const vault = await OpenPgpClientVault.replacePayload(
			this.vaultEmail, this.vaultRecord().vault, this.vaultKey, payload
		);
		const active = privateKeys.find(key => key.fingerprint === payload.activeFingerprint),
			publicKey = await keyArmor(active.key.toPublic());
		await this.persistVault(vault, publicKey);
		this.vaultPayload = payload;
		this.privateKeys(privateKeys);
		return true;
	}

	hasPublicKeyForEmails(recipients) {
		const emails = (recipients || []).map(normalizeEmail).filter(email => email);
		return !!emails.length && emails.every(email =>
			this.publicKeys().some(key => key.can_encrypt && key.for(email))
		);
	}

	getPrivateKeyFor(query) {
		const active = this.vaultPayload?.activeFingerprint;
		return this.privateKeys().find(key => key.fingerprint === active && key.for(query))
			|| findOpenPGPKey(this.privateKeys(), query);
	}

	async discoverPublicKey(email, refresh = false, timeout = 2000) {
		email = normalizeEmail(email);
		await this.publicKeyLoadPromise;
		if (!email || (!refresh && this.publicKeys().some(key => key.for(email)))) {
			return this.publicKeys().find(key => key.for(email)) || null;
		}
		const pending = this.publicKeyDiscoveryPromises.get(email);
		if (pending) {
			// A Send can share an active WKD request, but never a completed cached result.
			refresh && (pending.refresh = true);
			return pending.promise;
		}
		const discovery = { refresh: !!refresh, promise: null };
		discovery.promise = Promise.resolve().then(async () => {
			try {
				const response = await Remote.post('PgpDiscoverPublicKey', null, {
					email,
					timeoutMs: Math.max(500, Math.min(5000, timeout))
				}, Math.max(2000, timeout + 1000));
				const result = response?.Result;
				if (!result?.key || email !== normalizeEmail(result.email)) {
					discovery.refresh && await this.removePublicKeysForEmail(email);
					return null;
				}
				const binaryKey = decodeBase64(result.key),
					key = await openpgp.readKey({ binaryKey });
				if (key.isPrivate() || !key.users.some(user => normalizeEmail(user.userID?.email) === email)) {
					throw Error('WKD returned a public key for a different address');
				}
				await this.importPublicKeys([await keyArmor(key)], true, discovery.refresh ? email : '');
				const discovered = this.publicKeys().find(entry => entry.for(email) && entry.can_encrypt) || null;
				if (!discovered) {
					discovery.refresh && await this.removePublicKeysForEmail(email);
				}
				return discovered;
			} catch (error) {
				discovery.refresh && await this.removePublicKeysForEmail(email);
				throw error;
			} finally {
				this.publicKeyDiscoveryPromises.get(email) === discovery
					&& this.publicKeyDiscoveryPromises.delete(email);
			}
		});
		this.publicKeyDiscoveryPromises.set(email, discovery);
		return discovery.promise;
	}

	async missingPublishedPublicKeysForEmails(recipients, timeout = 2000) {
		const emails = (recipients || []).map(normalizeEmail).filter(email => email).validUnique();
		const discovered = await Promise.all(emails.map(email =>
			this.discoverPublicKey(email, true, timeout).catch(() => null)
		));
		return emails.filter((email, index) =>
			!(discovered[index]?.can_encrypt && discovered[index].for(email))
		);
	}

	async discoverPublicKeysForEmails(recipients, refresh = false, timeout = 2000) {
		const emails = (recipients || []).map(normalizeEmail).filter(email => email).validUnique();
		if (refresh) {
			// Send-time refresh must prove a current public WKD result, never a cached key.
			return !!emails.length && !(await this.missingPublishedPublicKeysForEmails(emails, timeout)).length;
		}
		await Promise.all(emails.map(email => this.discoverPublicKey(email, false, timeout).catch(error => {
			console.warn('WKD public key lookup failed for ' + email, error);
			return null;
		})));
		return this.hasPublicKeyForEmails(emails);
	}

	async decrypt(armoredText, sender) {
		await this.ensureVault();
		const publicKey = findOpenPGPKey(this.publicKeys(), sender);
		let lastError = null;
		for (const privateKey of this.privateKeys()) try {
			const decryptionKey = await decryptKey(privateKey, 'DECRYPT');
			if (!decryptionKey) {
				continue;
			}
			const decryptWith = async verificationKey => {
				const result = await openpgp.decrypt({
					message: await openpgp.readMessage({ armoredMessage: armoredText }),
					decryptionKeys: decryptionKey,
					verificationKeys: verificationKey?.key,
					format: 'utf8'
				});
				return { result, signatures: await signatureStatuses(result) };
			};
			let { result, signatures } = await decryptWith(publicKey);
			if (sender && signatures.some(signature => 0 !== signature.status)) {
				const refreshedKey = await this.discoverPublicKey(sender, true).catch(() => null);
				if (refreshedKey && refreshedKey.fingerprint !== publicKey?.fingerprint) {
					({ result, signatures } = await decryptWith(refreshedKey));
				}
			}
			return { data: result.data, signatures };
		} catch (error) {
			lastError = error;
		}
		throw lastError || Error('No private key can decrypt this message');
	}

	async verify(message) {
		const data = message.pgpSigned(),
			sender = message.from[0]?.email || '';
		if (!data || !sender) {
			return null;
		}
		let publicKey = findOpenPGPKey(this.publicKeys(), sender);
		if (!publicKey) {
			publicKey = await this.discoverPublicKey(sender, true).catch(() => null)
				|| findOpenPGPKey(this.publicKeys(), sender);
		}
		if (!publicKey) {
			return {
				checked: true,
				success: false,
				error: 'No public key is available for ' + sender
			};
		}
		data.folder = message.folder;
		data.uid = message.uid;
		const response = data.sigPartId
			? await Remote.post('PgpVerifyMessage', null, data)
			: (data.bodyPart
				? { Result: { text: data.bodyPart.raw, signature: data.sigPart.body } }
				: { Result: { text: message.plain(), signature: null } });
		const signature = response?.Result?.signature
			? await openpgp.readSignature({ armoredSignature: response.Result.signature }) : null,
			signedMessage = signature
				? await openpgp.createMessage({ text: response.Result.text })
				: await openpgp.readCleartextMessage({ cleartextMessage: response.Result.text });
		const verifyWith = async key => {
			const result = await openpgp.verify({
				message: signedMessage,
				verificationKeys: key.key,
				signature
			});
			return Promise.all((result.signatures || []).map(async item => {
				try {
					await item.verified;
					return true;
				} catch (error) {
					return false;
				}
			}));
		};
		let signatures = await verifyWith(publicKey);
		if (!signatures.length || !signatures.every(Boolean)) {
			const refreshedKey = await this.discoverPublicKey(sender, true).catch(() => null);
			if (refreshedKey && refreshedKey.fingerprint !== publicKey.fingerprint) {
				publicKey = refreshedKey;
				signatures = await verifyWith(publicKey);
			}
		}
		return {
			fingerprint: publicKey.fingerprint,
			checked: true,
			success: !!signatures.length && signatures.every(Boolean)
		};
	}

	async sign(text, privateKey, detached) {
		await this.ensureVault();
		const signingKey = await decryptKey(privateKey, 'SIGN');
		if (!signingKey) {
			throw Error('Signing canceled');
		}
		return openpgp.sign({
			message: detached
				? await openpgp.createMessage({ text })
				: await openpgp.createCleartextMessage({ text }),
			signingKeys: signingKey,
			detached: !!detached
		});
	}

	async encrypt(text, recipients, signPrivateKey = null, refresh = false) {
		const emails = (recipients || []).map(normalizeEmail).filter(email => email).validUnique();
		await this.discoverPublicKeysForEmails(emails, refresh, 2000);
		const keys = emails.map(email =>
			this.publicKeys().find(key => key.can_encrypt && key.for(email))
		).filter(key => key);
		if (emails.length !== keys.length) {
			throw Error('A recipient public key is unavailable');
		}
		const expectedRecipientKeyIds = await Promise.all(keys.map(key => keyEncryptionId(key.key)));
		if (signPrivateKey) {
			signPrivateKey = await decryptKey(signPrivateKey, 'SIGN');
			if (!signPrivateKey) {
				throw Error('Signing canceled');
			}
		}
		const encrypted = await openpgp.encrypt({
			message: await openpgp.createMessage({ text }),
			encryptionKeys: keys.map(key => key.key),
			signingKeys: signPrivateKey
		});
		const recipientKeyIds = (await openpgp.readMessage({ armoredMessage: encrypted }))
			.getEncryptionKeyIDs()
			.map(keyId => keyId.toHex().toUpperCase());
		if (!expectedRecipientKeyIds.every(keyId => recipientKeyIds.includes(keyId))) {
			throw Error('Encrypted message is missing a recipient key packet');
		}
		return encrypted;
	}
};
