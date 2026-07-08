import { SettingsCapa, SettingsGet } from 'Common/Globals';
//import { staticLink } from 'Common/Links';

//import { showScreenPopup } from 'Knoin/Knoin';

//import { EmailModel } from 'Model/Email';
//import { OpenPgpKeyModel } from 'Model/OpenPgpKey';

import { GnuPGUserStore } from 'Stores/User/GnuPG';
import { OpenPGPUserStore } from 'Stores/User/OpenPGP';
import { MailvelopeUserStore } from 'Stores/User/Mailvelope';

import Remote from 'Remote/User/Fetch';

export const
	BEGIN_PGP_MESSAGE = '-----BEGIN PGP MESSAGE-----',
//	BEGIN_PGP_SIGNATURE = '-----BEGIN PGP SIGNATURE-----',
//	BEGIN_PGP_SIGNED = '-----BEGIN PGP SIGNED MESSAGE-----',
//	BEGIN_PGP_PUBLIC_KEY = '-----BEGIN PGP PUBLIC KEY BLOCK-----',
//	END_PGP_PUBLIC_KEY = '-----END PGP PUBLIC KEY BLOCK-----',

	PgpUserStore = new class {
		constructor() {
			this.loginPassword = null;
		}

		rememberLoginPassword(email, password) {
			this.loginPassword = email && password ? { email, password } : null;
		}

		init() {
			const initKeyrings = () =>
				this.loadKeyrings()
					.then(() => this.bootstrapGnuPGFromLogin());

			if (SettingsCapa('OpenPGP') && window.crypto && crypto.getRandomValues) {
				rl.loadScript(SettingsGet('StaticLibsJs').replace('/libs.', '/openpgp.'))
//				rl.loadScript(staticLink('js/min/openpgp.min.js'))
					.then(initKeyrings)
					.catch(e => {
						initKeyrings();
						console.error(e);
					});
			} else {
				initKeyrings();
			}
		}

		loadKeyrings(identifier) {
			MailvelopeUserStore.loadKeyring(identifier);
			const openPgpReady = OpenPGPUserStore.loadKeyrings() || Promise.resolve(),
				gnuPgpReady = GnuPGUserStore.loadKeyrings() || Promise.resolve();
			return Promise.all([openPgpReady, gnuPgpReady]);
		}

		bootstrapGnuPGFromLogin() {
			const credentials = this.loginPassword;
			this.loginPassword = null;
			if (!credentials || !GnuPGUserStore.isSupported()) {
				return Promise.resolve();
			}

			return GnuPGUserStore.ensureKeyForLogin(credentials.email, credentials.password);
		}

		/**
		 * @returns {boolean}
		 */
		isSupported() {
			return !!(OpenPGPUserStore.isSupported() || GnuPGUserStore.isSupported() || window.mailvelope);
		}

		/**
		 * @returns {boolean}
		 */
		isEncrypted(text) {
			return 0 === text.trim().indexOf(BEGIN_PGP_MESSAGE);
		}

		importKey(key, gnuPG, backup) {
			if (gnuPG || backup) {
				Remote.request('PgpImportKey',
					(iError, oData) => {
						if (gnuPG && oData?.Result/* && (oData.Result.imported || oData.Result.secretimported)*/) {
							GnuPGUserStore.loadKeyrings();
						}
						iError && alert(oData.message);
					}, {
						key, gnuPG, backup
					}
				);
			}
			OpenPGPUserStore.importKey(key);
		}

		/**
		 * Checks if verifying/encrypting a message is possible with given email addresses.
		 * Returns the first library that can.
		 */
		hasPublicKeyForEmails(recipients) {
			if (recipients.length) {
				if (GnuPGUserStore.hasPublicKeyForEmails(recipients)) {
					return 'gnupg';
				}
				if (OpenPGPUserStore.hasPublicKeyForEmails(recipients)) {
					return 'openpgp';
				}
			}
			return false;
		}

		async decrypt(message) {
			const armoredText = message.plain();
			if (!this.isEncrypted(armoredText)) {
				throw Error('Not armored text');
			}

			// Use the server-stored GnuPG keyring first. OpenPGP.js remains a manual fallback.
			let result = await GnuPGUserStore.decrypt(message);
			if (result) {
				return result;
			}

			if (OpenPGPUserStore.isSupported()) {
				const sender = message.from[0].email;
				result = await OpenPGPUserStore.decrypt(armoredText, sender);
				if (result) {
					return result;
				}
			}

			// Try Mailvelope (does not support inline images)
			return MailvelopeUserStore.decrypt(message);
		}

		async verify(message) {
			const signed = message.pgpSigned(),
				sender = message.from[0].email;
			if (signed) {
				// OpenPGP only when inline, else we must download the whole message
				if (!signed.sigPartId && OpenPGPUserStore.hasPublicKeyForEmails([sender])) {
					return OpenPGPUserStore.verify(message);
				}
				if (GnuPGUserStore.hasPublicKeyForEmails([sender])) {
					return GnuPGUserStore.verify(message);
				}
				// Mailvelope can't
				// https://github.com/mailvelope/mailvelope/issues/434
			}
		}

		getPublicKeyOfEmails(recipients) {
			if (recipients.length) {
				let result = {};
				recipients.forEach(email => {
					OpenPGPUserStore.publicKeys().forEach(key => {
						if (key.for(email)) {
							result[email] = key.armor;
						}
					});
					GnuPGUserStore.publicKeys.map(async key => {
						if (!result[email] && key.for(email)) {
							result[email] = await key.fetch();
						}
					});
				});
				return result;
			}
			return false;
		}
	};
