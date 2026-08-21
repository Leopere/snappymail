// Copyright © 2026 ColinKnapp.com. All rights reserved.

/**
 * One-time migration of legacy server GnuPG keys into the browser vault.
 * Secret key armor and its historical passphrase arrive only inside an
 * ephemeral OpenPGP transport envelope and are immediately re-protected.
 */

import { OpenPgpClientVault } from 'Storage/OpenPgpVault';

const
	MAX_ENVELOPES = 64,
	MAX_SECRET_BYTES = 2 * 1024 * 1024,
	normalizeEmail = email => IDN.toASCII((email || '').trim()).toLowerCase(),
	exactKeys = (value, expected) => {
		if (!value || 'object' !== typeof value || Array.isArray(value)) {
			return false;
		}
		return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
	},
	fingerprint = key => key.getFingerprint().toUpperCase(),
	keyCanEncrypt = async key => {
		try {
			return !!await key.getEncryptionKey();
		} catch (error) {
			return false;
		}
	},
	validateActivePublicKey = async (armoredKey, email, activeFingerprint) => {
		if ('string' !== typeof armoredKey || MAX_SECRET_BYTES < armoredKey.length
			|| !armoredKey.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
			throw Error('Legacy migration did not provide a valid public key');
		}
		const key = await openpgp.readKey({ armoredKey }),
			emails = [...new Set(key.users.map(user => normalizeEmail(user.userID?.email)).filter(Boolean))];
		if (key.isPrivate() || 1 !== key.users.length || 1 !== emails.length || email !== emails[0]
			|| fingerprint(key) !== activeFingerprint || !await keyCanEncrypt(key)) {
			throw Error('The legacy public key does not match this mailbox');
		}
		await key.getSigningKey();
		return key;
	},
	decryptEnvelope = async (armoredMessage, transportPrivateKey) => {
		if ('string' !== typeof armoredMessage || MAX_SECRET_BYTES < armoredMessage.length
			|| !armoredMessage.includes('-----BEGIN PGP MESSAGE-----')) {
			throw Error('Invalid legacy key transport envelope');
		}
		const decrypted = await openpgp.decrypt({
				message: await openpgp.readMessage({ armoredMessage }),
				decryptionKeys: transportPrivateKey,
				format: 'utf8'
			}),
			entry = JSON.parse(decrypted.data);
		if (!exactKeys(entry, ['version', 'email', 'fingerprint', 'privateKey', 'passphrase'])
			|| 1 !== entry.version || 'string' !== typeof entry.email
			|| 'string' !== typeof entry.fingerprint || !/^[A-Fa-f0-9]{40,64}$/.test(entry.fingerprint)
			|| 'string' !== typeof entry.privateKey || MAX_SECRET_BYTES < entry.privateKey.length
			|| !entry.privateKey.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----')
			|| 'string' !== typeof entry.passphrase || 4096 < entry.passphrase.length) {
			throw Error('Invalid legacy key transport payload');
		}
		return { ...entry, email: normalizeEmail(entry.email), fingerprint: entry.fingerprint.toUpperCase() };
	};

export const createLegacyTransport = async email => {
	email = normalizeEmail(email);
	if (!email) {
		throw Error('No mailbox is available for legacy key migration');
	}
	return openpgp.generateKey({
		type: 'ecc',
		curve: 'curve25519',
		userIDs: [{ name: '', email }]
	});
};

export const migrateLegacyExport = async (email, result, transportPrivateArmor) => {
	email = normalizeEmail(email);
	if (!exactKeys(result, ['keys', 'detected', 'complete', 'activeFingerprint', 'publicKey'])
		|| 'boolean' !== typeof result.detected || 'boolean' !== typeof result.complete
		|| !Array.isArray(result.keys) || MAX_ENVELOPES < result.keys.length
		|| 'string' !== typeof result.activeFingerprint || 'string' !== typeof result.publicKey) {
		throw Error('Invalid legacy key migration response');
	}
	if (!result.detected) {
		if (!result.complete || result.keys.length || result.activeFingerprint || result.publicKey) {
			throw Error('Inconsistent legacy key migration response');
		}
		return null;
	}
	if (!result.complete || !result.keys.length) {
		throw Error('An existing OpenPGP key needs recovery before this vault can be created');
	}
	const activeFingerprint = result.activeFingerprint.toUpperCase();
	if (!/^[A-F0-9]{40,64}$/.test(activeFingerprint)) {
		throw Error('Legacy key migration did not identify one active key');
	}

	const transportPrivateKey = await openpgp.readPrivateKey({ armoredKey: transportPrivateArmor }),
		migrated = new Map();
	try {
		for (const armoredMessage of result.keys) {
			let entry = null, privateKey = null, reprotected = null, proof = null;
			try {
				entry = await decryptEnvelope(armoredMessage, transportPrivateKey);
				if (email !== entry.email || migrated.has(entry.fingerprint)) {
					throw Error('Legacy key migration returned a mismatched or duplicate key');
				}
				privateKey = await openpgp.readPrivateKey({ armoredKey: entry.privateKey });
				if (fingerprint(privateKey) !== entry.fingerprint
					|| !privateKey.users.some(user => email === normalizeEmail(user.userID?.email))) {
					throw Error('A legacy private key does not match this mailbox');
				}
				if (!privateKey.isDecrypted()) {
					privateKey = await openpgp.decryptKey({ privateKey, passphrase: entry.passphrase });
				}
				const newPassphrase = OpenPgpClientVault.createKeyPassphrase();
				reprotected = await openpgp.encryptKey({ privateKey, passphrase: newPassphrase });
				const armor = await reprotected.armor();
				proof = await openpgp.decryptKey({
					privateKey: await openpgp.readPrivateKey({ armoredKey: armor }),
					passphrase: newPassphrase
				});
				if (fingerprint(proof) !== entry.fingerprint) {
					throw Error('Legacy key re-protection changed its fingerprint');
				}
				migrated.set(entry.fingerprint, {
					armor,
					passphrase: newPassphrase,
					fingerprint: entry.fingerprint,
					publicKey: await proof.toPublic().armor()
				});
			} finally {
				privateKey?.clearPrivateParams?.();
				reprotected?.clearPrivateParams?.();
				proof?.clearPrivateParams?.();
				if (entry) {
					entry.privateKey = '';
					entry.passphrase = '';
				}
			}
		}
	} finally {
		transportPrivateKey.clearPrivateParams?.();
	}

	const active = migrated.get(activeFingerprint);
	if (!active) {
		throw Error('The active legacy key was not included in the migration');
	}
	const declaredPublicKey = await validateActivePublicKey(result.publicKey, email, activeFingerprint),
		derivedPublicKey = await validateActivePublicKey(active.publicKey, email, activeFingerprint);
	if (fingerprint(declaredPublicKey) !== fingerprint(derivedPublicKey)) {
		throw Error('The legacy private key does not match its published public key');
	}
	return {
		payload: {
			version: 1,
			activeFingerprint,
			privateKeys: [...migrated.values()].map(({ armor, passphrase, fingerprint }) => ({
				armor,
				passphrase,
				fingerprint
			}))
		},
		publicKey: result.publicKey
	};
};
