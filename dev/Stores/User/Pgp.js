import { SettingsCapa, SettingsGet } from 'Common/Globals';

import { OpenPGPUserStore } from 'Stores/User/OpenPGP';
import { MailvelopeUserStore } from 'Stores/User/Mailvelope';

import Remote from 'Remote/User/Fetch';

export const
	BEGIN_PGP_MESSAGE = '-----BEGIN PGP MESSAGE-----',
	BEGIN_PGP_SIGNED_MESSAGE = '-----BEGIN PGP SIGNED MESSAGE-----',

	PgpUserStore = new class {
	constructor() {
		this.readyPromise = Promise.resolve(false);
		this.initialized = false;
		this.loginEmail = '';
		this.loginPassword = '';
		this.legacyMigrationCapability = '';
	}

		setLoginPassword(email, password, migrationCapability = '') {
			this.loginEmail = IDN.toASCII((email || '').trim()).toLowerCase();
			this.loginPassword = password || '';
			this.legacyMigrationCapability = migrationCapability || '';
		}

	takeLoginPassword(email) {
		email = IDN.toASCII((email || '').trim()).toLowerCase();
		// Login plugins may canonicalize an alias after authentication. The password
		// belongs to this just-authenticated browser transition, not to the typed alias.
		const password = email ? this.loginPassword : '';
		this.loginPassword = '';
		return password;
	}

	takeLegacyMigrationCapability(email) {
		email = IDN.toASCII((email || '').trim()).toLowerCase();
		// Login plugins may canonicalize an alias after authentication. The server
		// capability is already bound to this session and its authenticated account.
		const capability = email ? this.legacyMigrationCapability : '';
		this.loginEmail = '';
		this.legacyMigrationCapability = '';
		return capability;
	}

	init() {
		if (this.initialized) {
			return this.readyPromise;
		}
		this.initialized = true;
		const email = SettingsGet('Email'),
			loadLibrary = SettingsCapa('OpenPGP') && window.crypto && crypto.getRandomValues,
			openPgpLibrary = SettingsGet('StaticLibsJs').replace('/libs.', '/openpgp.');
		let loginPassword = this.takeLoginPassword(email),
			legacyMigrationCapability = this.takeLegacyMigrationCapability(email);
		const loadKeyrings = () => this.loadKeyrings(email, loginPassword, legacyMigrationCapability),
			wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
			loadClientLibrary = async () => {
				if (!loadLibrary) {
					return;
				}
				try {
					await rl.loadScript(openPgpLibrary);
				} catch (error) {
					console.error('OpenPGP client library load failed', error);
					await wait(250);
					await rl.loadScript(openPgpLibrary);
				}
			},
			bootstrapVault = async () => {
				let error;
				for (let attempt = 0; attempt < 3; ++attempt) try {
					return await loadKeyrings();
				} catch (reason) {
					error = reason;
					if (!reason?.openPgpVaultReadFailure || 2 === attempt) {
						throw reason;
					}
					await wait(250);
				}
				throw error;
			};
		this.readyPromise = loadClientLibrary()
			.then(bootstrapVault)
			.finally(() => {
				loginPassword = '';
				legacyMigrationCapability = '';
			});
		return this.readyPromise;
	}

	ready() {
		return (this.initialized ? this.readyPromise : this.init())
			.then(() => OpenPGPUserStore.isVaultReady() && 0 < OpenPGPUserStore.privateKeys().length)
			.catch(() => false);
	}

		loadKeyrings(identifier, loginPassword = '', legacyMigrationCapability = '') {
			MailvelopeUserStore.loadKeyring(identifier);
			return OpenPGPUserStore.loadKeyrings(identifier, loginPassword, legacyMigrationCapability);
		}

		forgetSessionSecrets() {
		this.loginEmail = '';
		this.loginPassword = '';
		this.legacyMigrationCapability = '';
			OpenPGPUserStore.lock();
		}

		isSupported() {
			return !!(OpenPGPUserStore.isSupported() || window.mailvelope);
		}

		isEncrypted(text) {
			return 0 === (text || '').trim().indexOf(BEGIN_PGP_MESSAGE);
		}

		hasEncryptedArmor(text) {
			return (text || '').includes(BEGIN_PGP_MESSAGE);
		}

		importKey(key/*, gnuPG, backup*/) {
			return OpenPGPUserStore.importKey(key);
		}

		hasPublicKeyForEmails(recipients) {
			return OpenPGPUserStore.hasPublicKeyForEmails(recipients) ? 'openpgp' : false;
		}

		async discoverPublicKeysForEmails(recipients, refresh = false, timeout = 2000) {
			return OpenPGPUserStore.discoverPublicKeysForEmails(recipients, refresh, timeout);
		}

		async decrypt(message) {
			let armoredText = message.plain();
			if (!message.pgpEncrypted() && !this.isEncrypted(armoredText)) {
				throw Error('Not an OpenPGP encrypted message');
			}
			if (!this.isEncrypted(armoredText)) {
				try {
					const response = await Remote.post('PgpFetchEncryptedMessage', null, {
						folder: message.folder,
						uid: message.uid,
						partId: message.pgpEncrypted()?.partId || ''
					}, 8000);
					armoredText = response?.Result || '';
				} catch (error) {
					const retryable = Error(error?.message || 'Encrypted message data is temporarily unavailable');
					retryable.openPgpTransient = true;
					throw retryable;
				}
			}
			if (!this.isEncrypted(armoredText)) {
				const retryable = Error('Encrypted message data is temporarily unavailable');
				retryable.openPgpTransient = true;
				throw retryable;
			}
			const sender = message.from[0]?.email || '';
			sender && await OpenPGPUserStore.discoverPublicKey(sender, false).catch(() => null);
			return OpenPGPUserStore.decrypt(armoredText, sender);
		}

		async verify(message) {
			return OpenPGPUserStore.verify(message);
		}

		async getPublicKeyOfEmails(recipients) {
			await OpenPGPUserStore.discoverPublicKeysForEmails(recipients, false, 2000);
			const result = {};
			(recipients || []).forEach(email => {
				const key = OpenPGPUserStore.publicKeys().find(item => item.for(email));
				key && (result[email] = key.armor);
			});
			return Object.keys(result).length ? result : false;
		}
	};
