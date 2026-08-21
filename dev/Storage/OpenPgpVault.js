const
	VERSION = 2,
	KDF_ITERATIONS = 600000,
	SALT_BYTES = 16,
	IV_BYTES = 12,
	VAULT_KEY_BYTES = 32,
	KEY_PASSPHRASE_BYTES = 32,
	MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024,
	DEVICE_DATABASE = 'snappymail-openpgp-device-vault',
	DEVICE_STORE = 'keys',
	DEVICE_KEY_ID = 'device-key',
	encoder = new TextEncoder(),
	decoder = new TextDecoder('utf-8', { fatal: true }),
	normalizeEmail = email => IDN.toASCII((email || '').trim()).toLowerCase(),
	webCrypto = () => window.crypto?.subtle && window.crypto,
	assert = (condition, message) => {
		if (!condition) {
			throw Error(message);
		}
	},
	base64Url = bytes => {
		let binary = '';
		for (let index = 0; index < bytes.length; index += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
		}
		return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
	},
	fromBase64Url = (value, min = 1, max = MAX_CIPHERTEXT_BYTES) => {
		assert('string' === typeof value && /^[A-Za-z0-9_-]+$/.test(value), 'Invalid vault encoding');
		const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4),
			binary = atob(padded),
			bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
		assert(bytes.length >= min && bytes.length <= max, 'Invalid vault value length');
		return bytes;
	},
	randomBytes = length => {
		const crypto = webCrypto(), bytes = new Uint8Array(length);
		assert(crypto, 'Browser Web Crypto is unavailable');
		crypto.getRandomValues(bytes);
		return bytes;
	},
	createKeyPassphrase = () => base64Url(randomBytes(KEY_PASSPHRASE_BYTES)),
	context = (email, purpose) =>
		encoder.encode(`snappymail-openpgp-client-vault:v${VERSION}:${normalizeEmail(email)}:${purpose}`),
	clone = value => JSON.parse(JSON.stringify(value));

const exactKeys = (value, expected) => {
	if (!value || 'object' !== typeof value || Array.isArray(value)) {
		return false;
	}
	const actual = Object.keys(value).sort(), expectedKeys = expected.slice().sort();
	return actual.length === expectedKeys.length && actual.every((key, index) => key === expectedKeys[index]);
};

const validateCipher = cipher => {
	assert(exactKeys(cipher, ['name', 'iv', 'ciphertext']) && 'AES-256-GCM' === cipher.name,
		'Unsupported vault cipher');
	fromBase64Url(cipher.iv, IV_BYTES, IV_BYTES);
	fromBase64Url(cipher.ciphertext, 17);
	return cipher;
};

const validatePasswordWrapper = wrapper => {
	assert(exactKeys(wrapper, ['kdf', 'cipher']), 'Invalid vault password wrapper');
	assert(exactKeys(wrapper.kdf, ['name', 'hash', 'iterations', 'salt']), 'Invalid vault KDF');
	assert('PBKDF2-HMAC-SHA-256' === wrapper.kdf.name, 'Unsupported vault KDF');
	assert('SHA-256' === wrapper.kdf.hash, 'Unsupported vault KDF hash');
	assert(KDF_ITERATIONS === wrapper.kdf.iterations, 'Unsupported vault KDF parameters');
	fromBase64Url(wrapper.kdf.salt, SALT_BYTES, SALT_BYTES);
	validateCipher(wrapper.cipher);
	return wrapper;
};

const derivePasswordKey = async (password, salt) => {
	const crypto = webCrypto();
	assert(crypto, 'Browser Web Crypto is unavailable');
	assert('string' === typeof password && password.length, 'A login password is required');
	const material = await crypto.subtle.importKey(
		'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
	);
	return crypto.subtle.deriveKey({
		name: 'PBKDF2',
		hash: 'SHA-256',
		salt,
		iterations: KDF_ITERATIONS
	}, material, {
		name: 'AES-GCM',
		length: 256
	}, false, ['encrypt', 'decrypt']);
};

const importVaultKey = async vaultKey => {
	const crypto = webCrypto();
	assert(crypto, 'Browser Web Crypto is unavailable');
	assert(vaultKey instanceof Uint8Array && VAULT_KEY_BYTES === vaultKey.length, 'Invalid vault key');
	return crypto.subtle.importKey('raw', vaultKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

const encrypt = async (key, value, aad) => {
	const crypto = webCrypto(), iv = randomBytes(IV_BYTES);
	assert(crypto, 'Browser Web Crypto is unavailable');
	const ciphertext = await crypto.subtle.encrypt({
		name: 'AES-GCM',
		iv,
		additionalData: aad,
		tagLength: 128
	}, key, value);
	return {
		name: 'AES-256-GCM',
		iv: base64Url(iv),
		ciphertext: base64Url(new Uint8Array(ciphertext))
	};
};

const decrypt = async (key, cipher, aad) => {
	const crypto = webCrypto();
	assert(crypto, 'Browser Web Crypto is unavailable');
	validateCipher(cipher);
	return new Uint8Array(await crypto.subtle.decrypt({
		name: 'AES-GCM',
		iv: fromBase64Url(cipher.iv, IV_BYTES, IV_BYTES),
		additionalData: aad,
		tagLength: 128
	}, key, fromBase64Url(cipher.ciphertext, 17)));
};

const wrapVaultKeyWithPassword = async (email, vaultKey, password) => {
	const salt = randomBytes(SALT_BYTES), passwordKey = await derivePasswordKey(password, salt);
	return {
		kdf: {
			name: 'PBKDF2-HMAC-SHA-256',
			hash: 'SHA-256',
			iterations: KDF_ITERATIONS,
			salt: base64Url(salt)
		},
		cipher: await encrypt(passwordKey, vaultKey, context(email, 'password'))
	};
};

const unwrapVaultKeyWithPassword = async (email, wrapper, password) => {
	validatePasswordWrapper(wrapper);
	const passwordKey = await derivePasswordKey(
		password, fromBase64Url(wrapper.kdf.salt, SALT_BYTES, SALT_BYTES)
	), vaultKey = await decrypt(passwordKey, wrapper.cipher, context(email, 'password'));
	assert(VAULT_KEY_BYTES === vaultKey.length, 'Invalid vault key');
	return vaultKey;
};

const openDeviceDatabase = () => {
	assert('undefined' !== typeof indexedDB, 'Browser device storage is unavailable');
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DEVICE_DATABASE, 1);
		request.onerror = () => reject(request.error || Error('Unable to open browser device storage'));
		request.onupgradeneeded = () => {
			const database = request.result;
			!database.objectStoreNames.contains(DEVICE_STORE) && database.createObjectStore(DEVICE_STORE);
		};
		request.onsuccess = () => resolve(request.result);
	});
};

const readDeviceValue = async key => {
	const database = await openDeviceDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const request = database.transaction(DEVICE_STORE, 'readonly').objectStore(DEVICE_STORE).get(key);
			request.onerror = () => reject(request.error || Error('Unable to read browser device storage'));
			request.onsuccess = () => resolve(request.result);
		});
	} finally {
		database.close();
	}
};

const writeDeviceValue = async (key, value) => {
	const database = await openDeviceDatabase();
	try {
		await new Promise((resolve, reject) => {
			const transaction = database.transaction(DEVICE_STORE, 'readwrite');
			transaction.objectStore(DEVICE_STORE).put(value, key);
			transaction.onerror = () => reject(transaction.error || Error('Unable to write browser device storage'));
			transaction.onabort = () => reject(transaction.error || Error('Unable to write browser device storage'));
			transaction.oncomplete = resolve;
		});
	} finally {
		database.close();
	}
};

const deviceKeyLooksValid = key => key && 'secret' === key.type && 'AES-GCM' === key.algorithm?.name;

const deviceKey = async create => {
	let key = await readDeviceValue(DEVICE_KEY_ID);
	if (deviceKeyLooksValid(key)) {
		return key;
	}
	assert(create, 'This browser does not have a saved encryption device key');
	const crypto = webCrypto();
	assert(crypto, 'Browser Web Crypto is unavailable');
	key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
	await writeDeviceValue(DEVICE_KEY_ID, key);
	return key;
};

const deviceVaultId = async email => {
	const crypto = webCrypto();
	assert(crypto, 'Browser Web Crypto is unavailable');
	return 'vault:' + base64Url(new Uint8Array(await crypto.subtle.digest(
		'SHA-256', encoder.encode(normalizeEmail(email))
	)));
};

const decodePayload = async (email, vault, vaultKey) => {
	const payload = JSON.parse(decoder.decode(await decrypt(
		await importVaultKey(vaultKey), vault.payload, context(email, 'payload')
	)));
	assert(payload && 'object' === typeof payload && !Array.isArray(payload), 'Invalid vault payload');
	return payload;
};

export const OpenPgpClientVault = {
	VERSION,
	KDF_ITERATIONS,

	isSupported: () => !!webCrypto(),

	createKeyPassphrase,

	validate(vault) {
		assert(vault && VERSION === vault.version && exactKeys(vault, ['version', 'payload', 'wrappers']),
			'Unsupported vault version');
		validateCipher(vault.payload);
		assert(exactKeys(vault.wrappers, ['password']), 'Invalid vault wrappers');
		validatePasswordWrapper(vault.wrappers.password);
		return vault;
	},

	async create(email, payload, password) {
		email = normalizeEmail(email);
		assert(email, 'Invalid vault email');
		const vaultKey = randomBytes(VAULT_KEY_BYTES),
			key = await importVaultKey(vaultKey),
			vault = {
				version: VERSION,
				payload: await encrypt(key, encoder.encode(JSON.stringify(payload)), context(email, 'payload')),
				wrappers: {
					password: await wrapVaultKeyWithPassword(email, vaultKey, password)
				}
			};
		return { vault, vaultKey };
	},

	async unlockWithPassword(email, vault, password) {
		email = normalizeEmail(email);
		this.validate(vault);
		assert(email, 'Invalid vault email');
		const vaultKey = await unwrapVaultKeyWithPassword(email, vault.wrappers.password, password),
			payload = await decodePayload(email, vault, vaultKey);
		return { payload, vaultKey, unlockedWith: 'password' };
	},

	async unlockWithDevice(email, vault) {
		email = normalizeEmail(email);
		this.validate(vault);
		assert(email, 'Invalid vault email');
		const record = await readDeviceValue(await deviceVaultId(email));
		assert(exactKeys(record, ['version', 'cipher']) && 1 === record.version,
			'This browser does not have a saved encryption vault key');
		const vaultKey = await decrypt(await deviceKey(false), record.cipher, context(email, 'device')),
			payload = await decodePayload(email, vault, vaultKey);
		assert(VAULT_KEY_BYTES === vaultKey.length, 'Invalid vault key');
		return { payload, vaultKey, unlockedWith: 'device' };
	},

	async unlock(email, vault, password) {
		return this.unlockWithPassword(email, vault, password);
	},

	async rememberOnDevice(email, vaultKey) {
		email = normalizeEmail(email);
		assert(email, 'Invalid vault email');
		assert(vaultKey instanceof Uint8Array && VAULT_KEY_BYTES === vaultKey.length, 'Invalid vault key');
		const key = await deviceKey(true),
			cipher = await encrypt(key, vaultKey, context(email, 'device'));
		await writeDeviceValue(await deviceVaultId(email), { version: 1, cipher });
		return true;
	},

	async changePassword(email, vault, vaultKey, password) {
		this.validate(vault);
		vault = clone(vault);
		vault.wrappers.password = await wrapVaultKeyWithPassword(
			normalizeEmail(email), vaultKey, password
		);
		return vault;
	},

	async replacePayload(email, vault, vaultKey, payload) {
		this.validate(vault);
		vault = clone(vault);
		vault.payload = await encrypt(
			await importVaultKey(vaultKey),
			encoder.encode(JSON.stringify(payload)),
			context(normalizeEmail(email), 'payload')
		);
		return vault;
	}
};
