import ko from 'ko';

import { SettingsCapa } from 'Common/Globals';

//import { EmailModel } from 'Model/Email';
//import { OpenPgpKeyModel } from 'Model/OpenPgpKey';

import Remote from 'Remote/User/Fetch';

import { showScreenPopup } from 'Knoin/Knoin';
import { OpenPgpKeyPopupView } from 'View/Popup/OpenPgpKey';

import { Passphrases } from 'Storage/Passphrases';

import { baseCollator } from 'Common/Translator';

const
	canEncryptWithKey = key =>
		key.can_encrypt || key.subkeys.some(subkey => subkey.can_encrypt),

	findGnuPGKey = (keys, query, sign) =>
		keys.find(key =>
			(sign ? key.can_sign : (key.can_sign || key.can_decrypt))
			&& (key.for(query) || key.subkeys.find(key => query == key.keyid || query == key.fingerprint))
		),
	findGnuPGPublicKey = (publicKeys, privateKeys, email) =>
		publicKeys.find(key => canEncryptWithKey(key) && key.for(email))
		|| privateKeys.find(key => canEncryptWithKey(key) && key.for(email));

export const GnuPGUserStore = new class {
	constructor() {
		/**
		 * PECL gnupg / PEAR Crypt_GPG
		 * [ {email, can_encrypt, can_sign}, ... ]
		 */
		this.keyring;
		this.publicKeys = ko.observableArray();
		this.privateKeys = ko.observableArray();
		this.bootstrapPromise = null;
		this.loginPassphrases = new Map();
	}

	loadKeyrings() {
		this.keyring = null;
		this.publicKeys([]);
		this.privateKeys([]);
		if (!SettingsCapa('GnuPG')) {
			return Promise.resolve(false);
		}
		return new Promise(resolve =>
			Remote.request('GnupgGetKeys',
				(iError, oData) => {
					if (oData?.Result) {
						this.keyring = oData.Result;
						const initKey = (key, isPrivate) => {
							const
								aEmails = [],
								addEmail = value => {
									const email = IDN.toASCII(value || '').match(/[^\s<>]+@[^\s<>]+/)?.[0]?.toLowerCase();
									email && !aEmails.includes(email) && aEmails.push(email);
								};
							key.id = key.subkeys[0].keyid;
							key.fingerprint = key.subkeys[0].fingerprint;
							key.uids.forEach(uid => {
								addEmail(uid.email);
								addEmail(uid.uid);
								addEmail(uid.name);
							});
							key.emails = aEmails;
							key.for = email => aEmails.includes(IDN.toASCII(email || '').toLowerCase());
							key.askDelete = ko.observable(false);
							key.openForDeletion = ko.observable(null).askDeleteHelper();
							key.remove = () => {
								if (key.askDelete()) {
									Remote.request('GnupgDeleteKey',
										(iError, oData) => {
											if (oData) {
												if (iError) {
													alert(oData.message);
												} else if (oData.Result) {
													isPrivate
														? this.privateKeys.remove(key)
														: this.publicKeys.remove(key);
												}
											}
										}, {
											keyId: key.id,
											isPrivate: isPrivate
										}
									);
								}
							};
							if (isPrivate) {
								key.password = async btnTxt => {
									const rememberedPassphrase = this.passphraseForKey(key);
									if (rememberedPassphrase) {
										return rememberedPassphrase;
									}

									const pass = await Passphrases.ask(key,
										'GnuPG key<br>' + key.id + ' ' + key.emails[0],
										btnTxt
									);
									pass && pass.remember && Passphrases.handle(key, pass.password);
									return pass?.password;
								};
							}
							key.fetch = async callback => {
								if (key.armor) {
									callback && callback();
								} else {
									let pass = isPrivate ? await key.password('OPENPGP/POPUP_VIEW_TITLE') : '';
									if (null != pass) try {
										const result = await Remote.post('GnupgExportKey', null, {
											keyId: key.id,
											isPrivate: isPrivate,
											passphrase: pass
										});
										if (result?.Result) {
											key.armor = result.Result;
											callback && callback();
										} else {
											this.forgetPassphraseForKey(key);
										}
									} catch (e) {
										this.forgetPassphraseForKey(key);
										alert(e.message);
									}
								}
								return key.armor;
							};
							key.view = () => key.fetch(() => showScreenPopup(OpenPgpKeyPopupView, [key]));
							return key;
						},
						collator = baseCollator(),
						sort = keys => keys.sort(
							(a, b) => collator.compare(a.emails[0], b.emails[0]) || collator.compare(a.id, b.id)
						);
						this.publicKeys(sort(oData.Result.public.map(key => initKey(key, 0))));
						this.privateKeys(sort(oData.Result.private.map(key => initKey(key, 1))));
						console.log('gnupg ready');
					}
					resolve(oData?.Result || false);
				}
			)
		);
	}

	/**
	 * @returns {boolean}
	 */
	isSupported() {
		return SettingsCapa('GnuPG');
	}

	/**
		keyPair.privateKey
		keyPair.publicKey
		keyPair.revocationCertificate
		keyPair.onServer
		keyPair.inGnuPG
	 */
	storeKeyPair(keyPair, callback) {
		return new Promise(resolve =>
			Remote.request('PgpStoreKeyPair',
				(iError, oData) => {
					if (oData?.Result) {
//						this.gnupgKeyring = oData.Result;
					}
					callback?.(iError, oData);
					resolve(oData);
				}, keyPair
			)
		);
	}

	rememberPassphraseFor(email, passphrase) {
		email = IDN.toASCII((email || '').trim());
		if (!email || !passphrase) {
			return;
		}

		this.loginPassphrases.set('email:' + email.toLowerCase(), passphrase);
		this.privateKeys()
			.filter(key => key.for(email))
			.forEach(key => this.rememberKeyPassphrase(key, passphrase));
	}

	rememberKeyPassphrase(key, passphrase) {
		if (!key || !passphrase) {
			return;
		}

		Passphrases.handle(key, passphrase);
		key.fingerprint && this.loginPassphrases.set('fingerprint:' + key.fingerprint, passphrase);
		key.id && this.loginPassphrases.set('keyid:' + key.id, passphrase);
		(key.emails || []).forEach(email =>
			this.loginPassphrases.set('email:' + IDN.toASCII(email || '').toLowerCase(), passphrase)
		);
	}

	passphraseForKey(key) {
		if (!key) {
			return null;
		}

		const passphrase = Passphrases.handle(key)
			|| (key.fingerprint && this.loginPassphrases.get('fingerprint:' + key.fingerprint))
			|| (key.id && this.loginPassphrases.get('keyid:' + key.id))
			|| (key.emails || []).reduce((result, email) =>
				result || this.loginPassphrases.get('email:' + IDN.toASCII(email || '').toLowerCase())
			, null);

		passphrase && Passphrases.handle(key, passphrase);
		return passphrase || null;
	}

	forgetPassphraseForKey(key) {
		if (!key) {
			return;
		}

		Passphrases.delete(key);
		key.fingerprint && this.loginPassphrases.delete('fingerprint:' + key.fingerprint);
		key.id && this.loginPassphrases.delete('keyid:' + key.id);
		(key.emails || []).forEach(email =>
			this.loginPassphrases.delete('email:' + IDN.toASCII(email || '').toLowerCase())
		);
	}

	ensureKeyForLogin(email, passphrase) {
		email = IDN.toASCII((email || '').trim());
		if (!this.isSupported() || !email || !passphrase) {
			return Promise.resolve(null);
		}

		this.rememberPassphraseFor(email, passphrase);

		const key = this.getPrivateKeyFor(email, 1);
		if (key) {
			this.rememberKeyPassphrase(key, passphrase);
			return Promise.resolve(key);
		}

		if (this.bootstrapPromise) {
			return this.bootstrapPromise;
		}

		this.bootstrapPromise = Remote
			.post('GnupgGenerateKey', null, { email, passphrase }, 120000)
			.then(response => response?.Result
				? this.loadKeyrings().then(() => {
					const generatedKey = this.getPrivateKeyFor(email, 1);
					generatedKey && this.rememberKeyPassphrase(generatedKey, passphrase);
					return generatedKey;
				})
				: null
			)
			.catch(error => {
				console.error('GnuPG first-login bootstrap failed', error);
				return null;
			})
			.finally(() => this.bootstrapPromise = null);

		return this.bootstrapPromise;
	}

	/**
	 * Checks if verifying/encrypting a message is possible with given email addresses.
	 */
	hasPublicKeyForEmails(recipients) {
		const count = recipients.length,
			length = count ? recipients.filter(email =>
				this.getEncryptionKeyForEmail(email)
			).length : 0;
		return length && length === count;
	}

	getEncryptionKeyForEmail(email) {
		return findGnuPGPublicKey(this.publicKeys(), this.privateKeys(), email);
	}

	getPublicKeyFingerprints(recipients) {
		const fingerprints = [];
		recipients.forEach(email => {
			const key = this.getEncryptionKeyForEmail(email);
			key && fingerprints.push(key.fingerprint);
		});
		return fingerprints;
	}

	getPrivateKeyFor(query, sign) {
		return findGnuPGKey(this.privateKeys, query, sign);
	}

	hasRememberedDecryptionKey(message) {
		const pgpInfo = message?.pgpEncrypted?.();
		return !!pgpInfo && [message.to[0]?.email].concat(pgpInfo.keyIds || []).some(id => {
			const key = id && findGnuPGKey(this.privateKeys, id);
			return key && this.passphraseForKey(key);
		});
	}

	async decrypt(message) {
		const
			pgpInfo = message.pgpEncrypted();
		if (pgpInfo) {
			let ids = [message.to[0].email].concat(pgpInfo.keyIds),
				i = ids.length, key;
			while (i--) {
				key = findGnuPGKey(this.privateKeys, ids[i]);
				if (key) {
					break;
				}
			}
			if (key) {
				// Also check message.from[0].email
				let params = {
					folder: message.folder,
					uid: message.uid,
					partId: pgpInfo.partId,
					keyId: key.id,
					passphrase: await key.password('CRYPTO/DECRYPT'),
					data: '' // message.plain() optional
				}
				if (null != params.passphrase) {
					try {
						const response = await Remote.post('GnupgDecrypt', null, params);
						if (response?.Result?.data) {
							return response.Result;
						}
						throw response;
					} catch (e) {
						this.forgetPassphraseForKey(key);
						throw e;
					}
				}
			}
		}
	}

	async verify(message) {
		let data = message.pgpSigned(); // { partId: "1", sigPartId: "2", micAlg: "pgp-sha256" }
		if (data) {
			data = { ...data }; // clone
//			const sender = message.from[0].email;
//			let mode = await this.hasPublicKeyForEmails([sender]);
			data.folder = message.folder;
			data.uid = message.uid;
			if (data.bodyPart) {
				data.bodyPart = data.bodyPart.raw;
				data.sigPart = data.sigPart.body;
			}
			let response = await Remote.post('PgpVerifyMessage', null, data);
			if (response?.Result) {
				return {
					fingerprint: response.Result.fingerprint,
					success: 0 == response.Result.status, // GOODSIG
					error: response.Result.message
				};
			}
		}
	}

	async sign(privateKey) {
		return await privateKey.password('CRYPTO/SIGN');
	}

};
