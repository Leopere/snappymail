const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

assert(
	!fs.existsSync(path.join(root, 'dev/Stores/User/GnuPG.js')),
	'Legacy browser GnuPG state must not remain available for accidental reuse.'
);

const gnupgFactory = read('snappymail/v/0.0.0/app/libraries/snappymail/pgp/gnupg.php');
assert(
	!/static\s+\$instance\b/.test(gnupgFactory),
	'GnuPG factory must not use a process-wide singleton; PHP-FPM workers serve multiple users.'
);
assert(
	/return\s+new\s+GPG\s*\(\s*\$homedir\s*\)/.test(gnupgFactory),
	'GnuPG factory must instantiate the shell backend for the current account homedir.'
);
assert(
	/return\s+new\s+PECL\s*\(\s*\$homedir\s*\)/.test(gnupgFactory),
	'GnuPG factory must instantiate the PECL backend for the current account homedir.'
);

const pgpActions = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Pgp.php');
const mailMessage = read('snappymail/v/0.0.0/app/libraries/MailSo/Mail/Message.php');
assert(
	!mailMessage.includes('new GPG(') && !mailMessage.includes('getEncryptedMessageKeys('),
	'Mail message parsing must not start GnuPG just to discover optional encrypted-recipient metadata.'
);
assert(
	2 === (mailMessage.match(/'keyIds' => \$keyIds/g) || []).length
		&& mailMessage.includes("\\str_starts_with(\\ltrim($sText), '-----BEGIN PGP MESSAGE-----')"),
	'Mail message parsing must expose encrypted parts with empty optional key-id metadata without mistaking quoted armor for a top-level encrypted message.'
);
assert(
	pgpActions.includes('DoPgpClientVaultGet()')
		&& pgpActions.includes('DoPgpClientVaultPut()')
		&& pgpActions.includes('DoPgpClientVaultPasswordPut()')
		&& !pgpActions.includes('DoPgpClientVaultPasswordCheck()')
		&& pgpActions.includes('DoPgpClientVaultQuarantine()')
		&& pgpActions.includes('DoPgpClientVaultRestore()')
		&& pgpActions.includes("'.openpgp-client-vault'")
		&& pgpActions.includes("'BEGIN PGP PRIVATE KEY'"),
	'Private key material must be rejected by the opaque server vault endpoint.'
);
assert(
	pgpActions.includes('DoPgpFetchEncryptedMessage()')
		&& pgpActions.includes('DoPgpDiscoverPublicKey()')
		&& pgpActions.includes('Keyservers::wkd($email,'),
	'Browser crypto must receive encrypted MIME parts and WKD public keys without server GnuPG import.'
);
assert(
	pgpActions.includes('legacyTransportEnvelope(')
		&& pgpActions.includes("GetActionParam('transportPublicKey'")
		&& pgpActions.includes("'-----BEGIN PGP MESSAGE-----'")
		&& pgpActions.includes("'complete' => $complete"),
	'Legacy private-key migration must return only browser-transport-encrypted envelopes and fail closed on partial export.'
);
assert(
	/DoGnupgDecrypt\(\)[\s\S]{0,120}FalseResponse/.test(pgpActions)
		&& /DoGnupgGenerateKey\(\)[\s\S]{0,120}FalseResponse/.test(pgpActions)
		&& /DoGnupgSavePassphrase\(\)[\s\S]{0,120}FalseResponse/.test(pgpActions),
	'Server-side OpenPGP decrypt, key generation, and passphrase capture must be disabled.'
);

const pgpStore = read('dev/Stores/User/Pgp.js');
const legacyMigration = read('dev/Storage/OpenPgpLegacyMigration.js');
const appUser = read('dev/App/User.js');
assert(
	pgpStore.includes('this.readyPromise = Promise.resolve(false)')
		&& pgpStore.includes('ready()')
		&& pgpStore.includes('OpenPGPUserStore.isVaultReady() && 0 < OpenPGPUserStore.privateKeys().length'),
	'PgpUserStore readiness must mean that a browser vault and a private key are actually available.'
);

const messageView = read('dev/View/User/MailBox/MessageView.js');
const messageModel = read('dev/Model/Message.js');
const utilsUser = read('dev/Common/UtilsUser.js');
assert(
	messageView.includes('PgpUserStore.ready().then(ready =>')
		&& messageView.includes('if (!ready) {')
		&& messageView.includes('return false;'),
	'Message auto-decrypt must wait for a ready browser vault before decrypting.'
);
assert(
	messageView.includes('!message || !message.body || MessageUserStore.loading()')
		&& /if \(oMessage\.body\) \{\s*popup \|\| MessageUserStore\.message\(oMessage\);[\s\S]*?else \{\s*popup \|\| MessageUserStore\.loading\(true\);\s*popup \|\| MessageUserStore\.message\(oMessage\);/.test(utilsUser),
	'Message auto-decrypt must wait for the full Message body; list metadata must not race browser decryption.'
);
assert(
	!messageView.includes('&& GnuPGUserStore.hasDecryptionKey(message)'),
	'Message auto-decrypt must not skip server-managed decrypt just because browser keyrings are not loaded yet.'
);
assert(
	messageView.includes('messageHasEncryptedArmor')
		&& messageView.includes('messageIsPgpDecrypted')
		&& messageView.includes('message?.pgpDecrypted?.() && !messageHasEncryptedArmor(message)'),
	'Message view must not show OpenPGP decrypt success while encrypted armor remains visible.'
);
assert(
	messageView.includes('message.pgpDecrypted?.(false)')
		&& messageView.includes("this.reportPgpDecryptFailure(message, 'decrypted-flag-with-pgp-body')"),
	'Message view must revoke a stale pgpDecrypted flag and report when armor remains in the body.'
);
assert(
	!messageView.includes('encrypted.error\n\t\t\t\t\t|| message.pgpDecrypted()\n\t\t\t\t\t?'),
	'Message view must not use ambiguous || ?: precedence for OpenPGP decrypt status text.'
);

const openPgpStore = read('dev/Stores/User/OpenPGP.js');
const clientVault = read('dev/Storage/OpenPgpVault.js');
const wkd = read('snappymail/v/0.0.0/app/libraries/snappymail/pgp/wkd.php');
const recoverySettings = read('dev/Settings/User/Security.js');
const recoveryTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/SettingsSecurity.html');
const securityLocale = JSON.parse(read('snappymail/v/0.0.0/app/localization/en/user.json'));
const boomPayDomain = JSON.parse(read('deploy/snappymail-domains/boompay.ca.json'));
assert(
	pgpActions.includes("GetActionParam('Password', '')")
		&& pgpActions.includes('\\hash_equals($account->IncPassword(), $password)')
		&& pgpActions.includes('$this->imapConnect($account, false, $imap, 8)')
		&& pgpActions.includes('$this->loginErrorDelay()')
		&& pgpActions.includes("GetActionParam('passwordWrapper', '')")
		&& pgpActions.includes('$alreadyApplied = $currentRevision === $expectedRevision + 1')
		&& pgpActions.includes("$record['vault']['wrappers']['password'] = $wrapper")
		&& openPgpStore.includes("Remote.post('PgpClientVaultPasswordPut'")
		&& openPgpStore.includes('Password: currentPassword')
		&& 2 === (openPgpStore.match(/response = await request\(\)/g) || []).length
		&& openPgpStore.includes('JSON.stringify(vault.payload) !== JSON.stringify(current.vault.payload)')
		&& openPgpStore.includes('await this.validateVaultPayload(verified.payload, record.publicKey)')
		&& openPgpStore.includes('verified.vaultKey.fill(0)')
		&& openPgpStore.includes("vaultRecoveryFailure('local-load'")
		&& openPgpStore.includes("vaultRecoveryFailure('uncertain'")
		&& recoverySettings.includes('recoverVaultPassword(form)')
		&& recoverySettings.includes('OpenPGPUserStore.recoverVaultPassword(')
		&& recoveryTemplate.includes('vaultRecoveryPreviousPassword')
		&& recoveryTemplate.includes('vaultRecoveryCurrentPasswordConfirm')
		&& securityLocale.SETTINGS_SECURITY.VAULT_RECOVERY_SUCCESS
		&& true === boomPayDomain.IMAP.ssl.verify_peer
		&& true === boomPayDomain.IMAP.ssl.verify_peer_name
		&& true === boomPayDomain.SMTP.ssl.verify_peer
		&& true === boomPayDomain.SMTP.ssl.verify_peer_name,
	'Password recovery must verify the signed-in mailbox through fresh IMAP, replace only the vault wrapper, preserve key material, and expose a bounded UI over verified TLS.'
);
assert(
	pgpActions.includes("$record['status'] = 'quarantined'")
		&& pgpActions.includes('Wkd::unpublish($account->Email())')
		&& pgpActions.includes("'status' => 'active'")
		&& openPgpStore.includes("Remote.post('PgpClientVaultQuarantine'")
		&& openPgpStore.includes("Remote.post('PgpClientVaultRestore'")
		&& openPgpStore.includes('The private key did not match its public WKD key')
		&& openPgpStore.includes('Its public WKD key was withdrawn')
		&& wkd.includes('public static function unpublish(string $email) : bool'),
	'An unlock or private/public binding failure must withdraw WKD while preserving a recoverable encrypted vault.'
);
assert(
	pgpActions.includes('Wkd::publicKeyUsableForEmail($account->Email(), $publicKey)')
		&& wkd.includes('1 === $certificates && 1 === $uids && $canEncrypt && $canSign')
		&& openPgpStore.includes('1 !== key.users.length'),
	'Vault publication must independently require one exact mailbox UID plus usable signing and encryption capabilities.'
);
assert(
	wkd.includes("openpgpkey/.vault-transaction.lock")
		&& pgpActions.includes('Wkd::transaction(fn() : array => $this->clientVaultPutTransaction())')
		&& pgpActions.includes('Wkd::transaction(fn() : array => $this->clientVaultQuarantineTransaction())')
		&& pgpActions.includes('Wkd::transaction(fn() : array => $this->clientVaultRestoreTransaction())')
		&& pgpActions.includes('Wkd::transaction(fn() : array => $this->pgpLegacyProtectedKeyExportTransaction())'),
	'Vault storage, quarantine, restore, and WKD publication must share one transaction boundary.'
);
assert(
	pgpActions.includes('clientVaultPublicKeyPublished(')
		&& pgpActions.includes('restoreClientVaultRecord(')
		&& pgpActions.includes("'published' => true")
		&& openPgpStore.includes('record.published = true === result.published')
		&& openPgpStore.includes('true !== record.published')
		&& openPgpStore.includes('The OpenPGP public key could not be published to WKD.')
		&& wkd.includes('public static function matches(string $email, string $publicKey) : bool')
		&& wkd.includes('manifestHasEntry($email, $domain, static::hash($local))')
		&& wkd.includes('if (static::publishManifestEntry($email, $domain, $hash))')
		&& wkd.includes('\\flock($lock, LOCK_EX)')
		&& wkd.includes("throw new \\RuntimeException('WKD publication and key rollback both failed.')")
		&& wkd.includes('\\hash_equals($current, $binary)'),
	'Vault persistence must fail closed until the matching public key object and hashed manifest entry are present.'
);
assert(
	clientVault.includes("KDF_ITERATIONS = 600000")
		&& clientVault.includes("name: 'PBKDF2'")
		&& clientVault.includes("name: 'AES-GCM'")
		&& clientVault.includes("tagLength: 128"),
	'Browser vaults must use a 600k-iteration PBKDF2-HMAC-SHA-256 wrapper and AES-256-GCM payload encryption.'
);
assert(
		openPgpStore.includes("obsoletePrivateKeysItem = 'openpgp-private-keys'")
			&& openPgpStore.includes('storage.removeItem(obsoletePrivateKeysItem)')
			&& openPgpStore.includes('autoStartVault(loginPassword, record, legacyMigrationCapability)')
			&& openPgpStore.includes('createVault(loginPassword)')
			&& pgpStore.includes("const password = email ? this.loginPassword : ''")
			&& !openPgpStore.includes("Remote.request('GetPGPKeys'")
			&& openPgpStore.includes("Remote.post('PgpClientVaultGet'")
			&& openPgpStore.includes("Remote.post('PgpLegacyProtectedKeyExport'")
			&& openPgpStore.indexOf('await this.migrateLegacyVault(loginPassword, legacyMigrationCapability)')
				< openPgpStore.indexOf('await this.createVault(loginPassword)')
			&& openPgpStore.includes("migrationToken: migrationCapability")
			&& openPgpStore.includes('true === result.invalid')
			&& pgpActions.includes('issueLegacyMigrationCapability(')
			&& pgpActions.includes('consumeLegacyMigrationCapability(')
			&& pgpActions.includes("'invalid' => true")
			&& pgpActions.includes('clientVaultStorageOwner($account)')
			&& pgpActions.includes('ensureClientVaultStorageOwner($account)')
			&& pgpActions.includes('Moved a misplaced browser OpenPGP vault to its mailbox storage owner.')
			&& pgpActions.includes('gnuPGPrivateKeysForEmail(')
			&& pgpActions.includes('legacyMigrationState(')
			&& legacyMigration.includes('openpgp.decrypt({')
			&& legacyMigration.includes('openpgp.decryptKey({ privateKey, passphrase: entry.passphrase })')
			&& legacyMigration.includes('openpgp.encryptKey({ privateKey, passphrase: newPassphrase })')
			&& !pgpActions.includes('discardLegacyPrivateKeyState')
			&& /DoPgpLegacyPrivateKeyPurge\(\)[\s\S]{0,300}FalseResponse/.test(pgpActions)
			&& !openPgpStore.includes('AskPopupView'),
		'First login must migrate a recoverable legacy key before creating a new identity, and migration must never purge legacy state.'
);
assert(
	clientVault.includes('VERSION = 2')
		&& clientVault.includes('unlockWithPassword')
		&& clientVault.includes('unlockWithDevice')
		&& clientVault.includes('rememberOnDevice')
		&& clientVault.includes('changePassword')
		&& clientVault.includes("DEVICE_DATABASE = 'snappymail-openpgp-device-vault'")
		&& openPgpStore.includes("Remote.post('PgpDiscoverPublicKey'")
		&& openPgpStore.includes('discoverPublicKeysForEmails')
		&& openPgpStore.includes('missingPublishedPublicKeysForEmails')
		&& openPgpStore.includes('const discovered = await Promise.all')
		&& openPgpStore.includes('this.publicKeyUpdatePromise = Promise.resolve()')
		&& openPgpStore.includes('queuePublicKeyUpdate(update)')
		&& openPgpStore.includes('this.importPublicKeysNow(keys, persist, replaceEmail)')
		&& openPgpStore.includes('this.publicKeyDiscoveryPromises = new Map()')
		&& openPgpStore.includes('A Send can share an active WKD request, but never a completed cached result.')
		&& openPgpStore.includes('discovery.refresh && await this.removePublicKeysForEmail(email)')
		&& openPgpStore.includes('!(discovered[index]?.can_encrypt && discovered[index].for(email))'),
	'Browser OpenPGP must serialize concurrent public-key mutations, share only in-flight fresh WKD lookups, and remove stale public keys after a failed fresh WKD lookup.'
);
assert(
	openPgpStore.includes('replacementFingerprints')
		&& openPgpStore.includes('this.importPublicKeys([await keyArmor(key)], true, discovery.refresh ? email : \'\')')
		&& openPgpStore.includes('let publicKey = findOpenPGPKey(this.publicKeys(), sender);')
		&& openPgpStore.includes('if (!publicKey) {\n\t\t\tpublicKey = await this.discoverPublicKey(sender, true).catch(() => null)')
		&& openPgpStore.includes('const refreshedKey = await this.discoverPublicKey(sender, true).catch(() => null)')
		&& openPgpStore.includes('refreshedKey.fingerprint !== publicKey?.fingerprint')
		&& pgpStore.includes('discoverPublicKey(sender, false)'),
	'Signature verification must retain a known signer key through a transient WKD failure, replace a rotated key only after verification fails, and avoid a lookup on every decrypt.'
);
assert(
	pgpStore.includes('this.initialized = false')
		&& pgpStore.includes('OpenPGPUserStore.isVaultReady() && 0 < OpenPGPUserStore.privateKeys().length')
		&& appUser.indexOf('PgpUserStore.init();') < appUser.indexOf('loadFolders(')
		&& messageView.includes('PgpUserStore.ready().then(ready =>')
		&& !messageView.includes("reason = PgpUserStore.isSupported() ? 'no-decryption-key' : 'openpgp-unsupported'"),
	'Encrypted messages must wait for browser vault initialization rather than being marked unsupported when opened immediately after login.'
);
assert(
	openPgpStore.includes('loadVaultRecordWithRetry()')
		&& openPgpStore.includes('await new Promise(resolve => setTimeout(resolve, 250))')
		&& openPgpStore.includes('failure.openPgpVaultReadFailure = true')
		&& pgpStore.includes('!reason?.openPgpVaultReadFailure || 2 === attempt')
		&& openPgpStore.includes("if ('missing' !== this.vaultState())")
		&& openPgpStore.includes("this.vaultState('error')"),
	'A failed vault read must be retried in a bounded transport-only bootstrap and never be mistaken for an absent vault.'
);
assert(
	openPgpStore.includes('this.vaultStartupPromise = null')
		&& openPgpStore.includes('this.vaultStartupPromise = startup = this.publicKeyLoadPromise')
		&& openPgpStore.includes('return this.vaultStartupPromise.then(privateKeys =>'),
	'Vault startup must be single-flight so no caller starts a passwordless create/unlock while login bootstrap is in progress.'
);
assert(
	!clientVault.slice(clientVault.indexOf('async create('), clientVault.indexOf('async unlockWithPassword(')).includes('rememberOnDevice')
		&& openPgpStore.indexOf('await this.persistVault(created.vault, keyPair.publicKey);')
			< openPgpStore.indexOf('await OpenPgpClientVault.rememberOnDevice(this.vaultEmail, created.vaultKey)'),
	'A new device wrapper must be written only after its vault has been persisted successfully.'
);
assert(
	pgpStore.includes('retryable.openPgpTransient = true')
		&& messageModel.includes('data.retryable = true === e?.openPgpTransient')
		&& messageView.includes('encrypted?.retryable && attempts < 2')
		&& messageView.includes('setTimeout(() => this.autoSecureMessage(message), 250)')
		&& !messageView.includes('encrypted.retryable = true'),
	'Message decrypt may retry one typed transport failure but must not recurse into encrypted-looking plaintext.'
);
assert(
	openPgpStore.includes('this.publicKeyLoadPromise = Promise.resolve()')
		&& openPgpStore.includes('this.publicKeyLoadPromise = loadOpenPgpPublicKeys()')
		&& openPgpStore.includes('await this.publicKeyLoadPromise;'),
	'Fresh recipient WKD discovery must wait for the login-time public-key list without waiting for private-vault unlock.'
);
assert(
	openPgpStore.includes('keyEncryptionId = async key =>')
		&& openPgpStore.includes('expectedRecipientKeyIds')
		&& openPgpStore.includes('.getEncryptionKeyIDs()')
		&& openPgpStore.includes('Encrypted message is missing a recipient key packet'),
	'Browser encryption must inspect its own output and reject ciphertext missing any selected recipient encryption subkey.'
);

assert(
	pgpStore.includes('hasEncryptedArmor(text)'),
	'PgpUserStore must expose a body-wide armor detector for decrypt truth checks.'
);

assert(
	messageModel.includes('PgpUserStore.isEncrypted(oMessage.plain())')
		&& messageModel.includes('PgpUserStore.isEncrypted(oMessage.html())')
		&& messageModel.includes("throw Error('Decryption returned encrypted data')"),
	'Message decrypt must refuse to set pgpDecrypted when its decrypted payload is another top-level encrypted message.'
);
assert(
	messageModel.includes('this.pgpDecrypted() && (')
		&& messageModel.includes('delete json.plain;')
		&& messageModel.includes('delete json.html;')
		&& messageModel.includes('delete json.pgpEncrypted;')
		&& messageModel.includes('delete json.pgpSigned;'),
	'A stale armored full-message response must not overwrite an already decrypted body or verified signature state.'
);

const composeView = read('dev/View/Popup/Compose.js');
const composeTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/PopupsCompose.html');
const userLocalization = read('snappymail/v/0.0.0/app/localization/en/user.json');
assert(
	!composeView.includes('GnuPGUserStore')
		&& composeView.includes('await OpenPGPUserStore.ensureVault()')
		&& composeView.includes('const vaultReady = await PgpUserStore.ready();')
		&& composeView.indexOf('missingPublishedPublicKeysForEmails(recipients, 2000)')
			< composeView.indexOf('await OpenPGPUserStore.ensureVault()')
		&& composeView.includes('await OpenPGPUserStore.discoverPublicKeysForEmails(encryptionRecipients, false, 2000)')
		&& composeView.includes('await this.initEncrypt(false)')
		&& composeView.includes('const state = this.automaticOpenPgpState();')
		&& composeView.includes('const usePlaintextFallback = notice =>')
		&& composeView.includes('requiresOpenPgpProtection()')
		&& composeView.includes("throw Error(i18n('COMPOSE/OPENPGP_INTERNAL_REQUIRED'")
		&& composeView.includes('this.plaintextFallbackPending = true')
		&& composeView.includes("this.plaintextNotice(notice || i18n('COMPOSE/OPENPGP_PLAINTEXT_NOTICE'))")
		&& composeView.includes('this.doSign(false)')
		&& composeView.includes('this.doEncrypt(false)')
		&& !composeView.includes('ERROR_OPENPGP_RECIPIENTS_REQUIRED')
		&& !composeView.includes('internalOpenPgpState()'),
	'Compose must encrypt a fully usable recipient set, fail closed for same-domain delivery, and otherwise prepare one plaintext message.'
);
assert(
	composeView.includes('automaticOpenPgpState()')
		&& composeView.includes('ready: !!(recipients.length && signingKey && OpenPGPUserStore.hasPublicKeyForEmails(encryptionRecipients))')
		&& composeView.includes('if (!draft && automaticOpenPgp && (hasAttachments || !Text.length))')
		&& composeView.includes('delete params.encrypted')
		&& composeView.includes('params.autocrypt = []')
		&& composeView.includes("if (draft && this.mailvelope && 'mailvelope' === this.viewArea())")
		&& composeTemplate.includes('visible: plaintextNotice, text: plaintextNotice')
		&& userLocalization.includes('OPENPGP_PLAINTEXT_NOTICE')
		&& userLocalization.includes('OPENPGP_PLAINTEXT_RECIPIENTS_NOTICE')
		&& userLocalization.includes('OPENPGP_INTERNAL_REQUIRED')
		&& userLocalization.includes('OPENPGP_PLAINTEXT_VAULT_NOTICE')
		&& userLocalization.includes('OPENPGP_PLAINTEXT_CONFIRMATION')
		&& userLocalization.includes('OPENPGP_SEND_PLAINTEXT'),
	'Same-domain protection gaps must block sending; external or mixed-domain gaps must retain all recipients, restore plaintext, and show a truthful warning.'
);

const wkdLibrary = read('snappymail/v/0.0.0/app/libraries/snappymail/pgp/wkd.php');
const wkdSync = read('scripts/sync-wkd-static-sites.cjs');
const messageActionsContract = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Messages.php');
assert(
	pgpActions.includes("Wkd::publicKeyMatchesEmail($email, $record['publicKey'])")
		&& wkdLibrary.includes('public static function publicKeyMatchesEmail')
		&& wkdLibrary.includes('publicKeyMatchesObject($domain, $hash, $key)')
		&& !wkdSync.includes('storage_root=')
		&& !wkdSync.includes('/.gnupg')
		&& wkdSync.includes('replaceTreeAtomically(targetRoot, staged =>')
		&& messageActionsContract.includes('requiresClientPgpEncryption(')
		&& messageActionsContract.includes('$account->Email()')
		&& messageActionsContract.includes('$this->GetIdentities($account)')
		&& messageActionsContract.includes("'The From address is not owned by the authenticated account.'")
		&& messageActionsContract.includes("'Same-domain mail requires browser OpenPGP encryption.'"),
	'Browser-vault keys must remain bound to their mailbox identity, and static sync must only copy validated active WKD objects.'
);

const askView = read('dev/View/Popup/Ask.js');
const prepareIndex = composeView.indexOf('this.getMessageRequestParams(sSentFolder)');
const confirmIndex = composeView.indexOf('const confirmPlaintextSend = params =>');
const confirmThenIndex = composeView.indexOf('.then(confirmPlaintextSend)', prepareIndex);
assert(
	confirmIndex >= 0
		&& prepareIndex < confirmThenIndex
		&& composeView.includes('if (!this.plaintextFallbackPending)')
		&& composeView.includes('() => sendMessage(params)')
		&& composeView.includes('() => this.sending(false)')
		&& composeView.includes("'.buttonNo'")
		&& askView.includes("noBtnText = ''")
		&& askView.includes("this.noButton(i18n(noBtnText || (ask ? 'GLOBAL/CANCEL' : 'GLOBAL/NO')))")
		&& askView.includes("true === focusOnShow"),
	'Plaintext fallback must require an explicit send decision, default focus to Cancel, and make cancel leave the compose unsent.'
);
const sendRequest = composeView.slice(composeView.indexOf("Remote.request('SendMessage'"), confirmIndex);
const saveRequest = composeView.slice(composeView.indexOf("Remote.request('SaveMessage'"), composeView.indexOf('\n\tdeleteCommand()'));
assert(
	/params,\s*30000/.test(sendRequest) && /params,\s*200000/.test(saveRequest),
	'Send and draft-save requests need their stable 30-second and 200-second client deadlines.'
);

const keyservers = read('snappymail/v/0.0.0/app/libraries/snappymail/pgp/keyservers.php');
assert(
	keyservers.includes('wkdDeadline(int $timeoutMs)')
		&& keyservers.includes('wkdFetchUrl(string $url, float $deadline, int $maximumTimeout = 0)')
		&& keyservers.includes('public static function wkd(string $email, int $timeoutMs = 2000)'),
	'Server WKD discovery must enforce a request deadline instead of using the long keyserver timeout.'
);
assert(
	keyservers.includes('$previousTimeout = $HTTP->timeout')
		&& keyservers.includes('$previousForceIpv4 = $HTTP->force_ipv4')
		&& keyservers.includes('$HTTP->timeout = $timeout')
		&& keyservers.includes('$HTTP->force_ipv4 = true')
		&& keyservers.includes('catch (\\Throwable $e)')
		&& keyservers.includes('WKD fetch failed for {$url}')
		&& keyservers.includes('$HTTP->timeout = $previousTimeout')
		&& keyservers.includes('$HTTP->force_ipv4 = $previousForceIpv4'),
	'Server WKD fetch must apply and restore bounded HTTP timeout/IPv4 preference and convert network failures into clean misses.'
);
assert(
	keyservers.includes('$timeout = \\min($timeout, $maximumTimeout)')
		&& keyservers.includes('Retrying WKD fetch for {$url}')
		&& keyservers.includes('static::wkdFetchUrl($url, $deadline, 1)'),
	'The standard advanced WKD endpoint must get one bounded retry instead of consuming the complete send-time lookup window.'
);

const liveContract = read('tests/playwright/openpgp-send-contract.cjs');
assert(
	liveContract.includes("'static/js/min/libs.min.js'")
		&& liveContract.includes("'static/js/min/app.min.js'")
		&& liveContract.includes("'static/js/min/openpgp.min.js'")
		&& liveContract.includes('attachPageDiagnostics')
		&& liveContract.includes('requestStarts')
		&& liveContract.includes('responses')
		&& liveContract.includes('requestFailures')
		&& liveContract.includes('failedResponses')
		&& liveContract.includes('requestAction')
		&& liveContract.includes('Authenticated session returned to the sign-in screen')
		&& liveContract.includes('forwardEnabled')
		&& liveContract.includes('delivery')
		&& liveContract.includes('forwardCommand?.canExecute?.()')
		&& liveContract.includes('true === signature?.success')
		&& liveContract.includes('#more-view-dropdown-id'),
	'The live OpenPGP gate must verify every boot-critical browser bundle and preserve browser network diagnostics on failure.'
);

const jsTasks = read('tasks/js.js');
const commonTasks = read('tasks/common.js');
assert(
	jsTasks.includes("config.paths.staticJS + '*.js'")
		&& jsTasks.includes("config.paths.staticJS + '*.map'")
		&& jsTasks.includes("const jsStagePath = config.paths.staticMinJS + '.next/'")
		&& jsTasks.includes('.pipe(gulp.dest(jsStagePath))')
		&& jsTasks.includes('fs.promises.rename(')
		&& jsTasks.includes("'boot.min.js' === left")
		&& !jsTasks.includes("config.paths.staticJS + '/**/*.{js,map}'"),
	'Browser builds must stage and atomically publish minified assets without removing the active bundle.'
);
assert(
	!commonTasks.includes('del(config.paths.staticJS)'),
	'Build setup must not delete the active JavaScript directory before staged assets are published.'
);
const packageManifest = JSON.parse(read('package.json'));
const staticBuildTest = read('tests/security/static-build-continuity.cjs');
assert(
	packageManifest.scripts['test:static-build']
		&& packageManifest.scripts['verify:openpgp'].includes('npm run test:static-build')
		&& staticBuildTest.includes('setInterval(checkContinuity, 10)')
		&& staticBuildTest.includes('if (100 <= Date.now() - since)')
		&& staticBuildTest.includes('static/js/min/boot.min.js')
		&& staticBuildTest.includes('static/js/min/libs.min.js')
		&& staticBuildTest.includes('static/js/min/app.min.js')
		&& staticBuildTest.includes('static/js/min/openpgp.min.js'),
	'Release verification must monitor every boot-critical browser asset while the build runs.'
);

const boot = read('dev/boot.js');
assert(
	boot.includes('loadAppData = () =>')
		&& boot.includes("setTimeout(() => controller.abort(), 2000)")
		&& boot.includes('retry = (request, attempts = 4)')
		&& boot.includes('wait(150).then(() => retry(request, attempts - 1))')
		&& boot.includes('return retry(request);')
		&& boot.includes('.then(loadAppData)'),
	'Browser bootstrap must bound and retry AppData instead of leaving the login spinner indefinitely on a stalled request.'
);

const openPgpCiWorkflow = read('.github/workflows/openpgp-contract.yml');
assert(
	openPgpCiWorkflow.includes('npx playwright install --with-deps chromium')
		&& openPgpCiWorkflow.includes('run: npm run test:static-build')
		&& openPgpCiWorkflow.includes('run: npm run check')
		&& openPgpCiWorkflow.includes('run: npm run test:openpgp'),
	'OpenPGP CI must build, lint, and run deterministic browser contracts on every protected change.'
);
assert(
	keyservers.indexOf('"https://openpgpkey.{$domain}/.well-known/openpgpkey/{$domain}/hu/{$hash}?l="')
		< keyservers.indexOf('"https://{$domain}/.well-known/openpgpkey/hu/{$hash}?l="'),
	'WKD key discovery must try the advanced openpgpkey host before the direct root path.'
);
assert(
	!keyservers.includes('Wkd::read($domain, $hash, $local)')
		&& keyservers.includes('only a domain-owned public WKD result proves'),
	'WKD discovery must reject a managed local key cache when the recipient has not published a current public key.'
);

const messageActions = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Messages.php');
assert(
	messageActions.includes('Server-side OpenPGP signing and encryption are disabled.')
		&& !messageActions.includes('$this->GnuPG()')
		&& !messageActions.includes('gnuPG')
		&& !messageActions.includes('Keyservers::wkd')
		&& messageActions.includes('Browser OpenPGP encryption did not return an armored message.'),
	'SendMessage must contain no server GnuPG path and accept only browser-armored OpenPGP payloads.'
);
const messageListStore = read('dev/Stores/User/Messagelist.js');
assert(
	messageListStore.includes('mutationLoading: false')
		&& messageListStore.includes('MessagelistUserStore.mutationLoading(true)')
		&& messageListStore.includes('MessagelistUserStore.mutationLoading(false)')
		&& messageListStore.includes('MessagelistUserStore.reload(false, true);')
		&& messageActions.includes('array($sFolder));'),
	'Message mutations must serialize client changes, reload authoritative state after a failed request, and never return an undefined delete-folder variable.'
);

const userActions = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/User.php');
assert(
	!userActions.includes('$this->GnuPG()')
		&& userActions.includes('$this->Logout($bMain);'),
	'Logout must not create or touch a server GnuPG homedir in the browser-only workflow.'
);

const passphrases = read('dev/Storage/Passphrases.js');
const settingsStore = read('dev/Stores/User/Settings.js');
const securitySettings = read('dev/Settings/User/Security.js');
const securityTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/SettingsSecurity.html');
const appActions = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php');
const loginView = read('dev/View/User/Login.js');
const userAuth = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/UserAuth.php');
const pgpBackup = read('snappymail/v/0.0.0/app/libraries/snappymail/pgp/backup.php');
assert(
	pgpBackup.includes('public static function clearPrivateKeys() : bool')
		&& !/clearPrivateKeys\(\)[\s\S]{0,500}StorageType::PGP,\s*true/.test(pgpBackup)
		&& pgpBackup.includes('if (!$dir || !\\is_dir($dir))'),
	'Legacy-key cleanup must not recreate an empty .pgp directory after a clean browser-vault cutover.'
);
assert(
	passphrases.includes('clearAll: () =>')
		&& passphrases.includes('Session logout is the sole expiry boundary')
		&& !passphrases.includes('SettingsUserStore.keyPassForget'),
	'Browser private-key passphrases must remain only for the authenticated session and clear together at logout.'
);
assert(
		pgpStore.includes('forgetSessionSecrets()')
		&& pgpStore.includes('OpenPGPUserStore.lock();')
		&& appUser.includes('PgpUserStore.forgetSessionSecrets();'),
	'Explicit and automatic logout must release every in-memory browser OpenPGP private key and passphrase.'
);
assert(
	appUser.includes('ComposeType.ForwardAsAttachment === params[0]')
		&& appUser.includes('PgpUserStore.ready()')
		&& appUser.includes('const armorRemains = PgpUserStore.hasEncryptedArmor')
		&& appUser.includes('cannot be forwarded as readable mail'),
	'Ordinary reply and forward must wait for browser decryption and refuse to copy unresolved PGP armor into a new message.'
);
assert(
		appUser.includes("TYPE: 'OpenPGP'")
			&& appUser.includes('cannot be forwarded as readable mail')
			&& !appUser.includes('Message could not be decrypted with the login password'),
		'OpenPGP failure UI must not imply that a mail-login password unlocks browser-only private keys.'
);
assert(
	settingsStore.includes('const sessionTimeout = value => Math.max(5, Math.min(1440')
		&& settingsStore.includes('autoLogout: 30')
		&& settingsStore.includes('autoLogoutDisabled: 0')
		&& settingsStore.includes('!self.autoLogoutDisabled() && 0 < self.autoLogout()')
		&& !settingsStore.includes("!SettingsGet('accountSignMe')")
		&& securitySettings.includes('{ id: 1440')
		&& securitySettings.includes('autoLogoutDisabled = SettingsUserStore.autoLogoutDisabled')
		&& securitySettings.includes("addSetting('AutoLogoutDisabled')")
		&& securityTemplate.includes("label: 'SETTINGS_SECURITY/DISABLE_AUTOLOGOUT'")
		&& securityTemplate.includes('DISABLE_AUTOLOGOUT_WARNING')
		&& userActions.includes("'AutoLogoutDisabled', 'bool'")
		&& userActions.includes('$iValue = $cCallback($iValue);')
		&& userActions.includes('if (!$oAccount) {')
		&& appActions.includes("'AutoLogoutDisabled' => false")
		&& appActions.includes("GetConf('AutoLogoutDisabled', false)")
		&& !securitySettings.includes('keyPassForget'),
	'Auto logout must default to 30 minutes, allow one explicit warned disabled state, and cap enabled sessions at one day.'
);
assert(
		loginView.includes('PgpUserStore.setLoginPassword(email, loginPassword, migrationCapability)')
			&& loginView.includes('delete oData.Result.OpenPgpLegacyMigrationCapability')
			&& pgpStore.includes("setLoginPassword(email, password, migrationCapability = '')")
			&& pgpStore.includes('takeLoginPassword(email)')
			&& pgpStore.includes('takeLegacyMigrationCapability(email)')
			&& userActions.includes("data['OpenPgpLegacyMigrationCapability']")
			&& openPgpStore.includes('OpenPgpClientVault.create(this.vaultEmail, payload, loginPassword)')
			&& openPgpStore.includes('OpenPgpClientVault.changePassword(')
			&& !userAuth.includes('saveGnuPGPassphrase($oAccount->Email()')
			&& !userAuth.includes('ensureGnuPGKeyForLogin($oAccount->Email()'),
		'The successful login password must be held only in browser memory long enough to create or rewrap an opaque vault, never in server GnuPG state.'
);
assert(
		!pgpActions.includes('saveGnuPGPassphrase(')
			&& !pgpActions.includes('ensureGnuPGKeyForLogin(')
			&& !pgpActions.includes('gnuPGDecryptWithSignatures('),
		'Legacy migration must not retain server key generation, passphrase capture, or message decryption helpers.'
);
assert(
	pgpBackup.includes("if (\\str_contains($key, 'PGP PRIVATE KEY')) {")
		&& pgpBackup.includes('return false;')
		&& pgpBackup.includes('clearPrivateKeys() : bool')
		&& !pgpBackup.includes('Crypt::Decrypt($key, $hash)'),
	'Server key backup storage must reject private OpenPGP armor and expose only an explicit legacy cleanup path.'
);
assert(
	securitySettings.includes('browser-encrypted private key vault')
		&& !securitySettings.includes('server GPG private key')
		&& !securitySettings.includes('changeVaultPassphrase')
		&& !securitySettings.includes('migrateLegacyPrivateKeys'),
	'User security settings must describe the automatic browser-encrypted vault without manual migration controls.'
);

const contactsActions = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Contacts.php');
const contactsStore = read('dev/Stores/User/Contact.js');
const contactsSettings = read('dev/Settings/User/Contacts.js');
const contactsTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/SettingsContacts.html');
const davClient = read('snappymail/v/0.0.0/app/libraries/snappymail/dav/client.php');
const cardDav = read('snappymail/v/0.0.0/app/libraries/RainLoop/Providers/AddressBook/CardDAV.php');
const pdoAddressBook = read('snappymail/v/0.0.0/app/libraries/RainLoop/Providers/AddressBook/PdoAddressBook.php');
assert(
	contactsActions.includes('DoDiscoverContactsSync()')
		&& contactsActions.includes('contactsSyncDiscoveryUrls')
		&& contactsActions.includes('$sUser = $oAccount->Email() ?: $oAccount->ImapUser();')
		&& contactsActions.includes("'Auto' => true")
		&& contactsActions.includes("'Disabled' => false")
		&& contactsActions.includes("'Timeout' => 3")
		&& contactsActions.includes("'Deadline' => 4"),
	'CardDAV must be discovered asynchronously from trusted mail-host candidates and enabled read-only by default.'
);
assert(
	contactsStore.includes('syncAuto: false')
		&& contactsStore.includes('ContactUserStore.syncAuto(!!config.Auto)')
		&& contactsSettings.includes("syncSuccess(i18n('SETTINGS_CONTACTS/SYNC_TEST_SUCCESS'))")
		&& contactsTemplate.includes('SYNC_CONFIGURED_AUTOMATICALLY')
		&& contactsTemplate.includes('SETTINGS_CONTACTS/TEST_CONNECTION'),
	'Automatic CardDAV setup must be visible, and a manual connection test must report success instead of staying silent.'
);
const contactsTestAction = contactsActions.slice(
	contactsActions.indexOf('public function DoTestContactsSyncData()'),
	contactsActions.indexOf('public function DoContactsSync()')
);
assert(
	!contactsTestAction.includes('EncryptToJSON')
		&& !contactsTestAction.includes('PasswordHMAC')
		&& contactsTestAction.includes("'Timeout' => 5"),
	'The temporary CardDAV test must use the decrypted password and a bounded request, never a storage-encrypted value.'
);
const contactsDiscoveryAction = contactsActions.slice(
	contactsActions.indexOf('public function DoDiscoverContactsSync()'),
	contactsActions.indexOf('public function DoSaveContactsSyncData()')
);
assert(
	!contactsDiscoveryAction.includes('$oDriver->SetEmail'),
	'Automatic CardDAV discovery must not initialize the local contacts database before a DAV endpoint is confirmed.'
);
assert(
	contactsActions.includes("'Auto' => false")
		&& contactsActions.includes("'Disabled' => 0 === $iMode"),
	'Choosing No in contact sync settings must persist an explicit opt-out instead of being re-enabled automatically.'
);
assert(
	davClient.includes('[301, 302, 307, 308]')
		&& davClient.includes('unsafe DAV redirect')
		&& davClient.includes('isSameOrigin(string $url)')
		&& davClient.includes('lastRequestPath()')
		&& davClient.includes('private float $deadline = 0;')
		&& davClient.includes('DAV discovery deadline exceeded')
		&& cardDav.includes("Config()->Get('ssl', 'verify_certificate', true)")
		&& cardDav.includes('getLegacyNextcloudContactsPaths')
		&& cardDav.includes('selectContactsPath')
		&& cardDav.includes("if (!empty($this->aDAVConfig['Auto']))")
		&& cardDav.includes("'/addressbooks/' . \\rawurlencode($sUser)")
		&& !cardDav.includes('WriteDump($aPaths)')
		&& !cardDav.includes('setVerifyPeer(false)')
		&& pdoAddressBook.includes('$oClient = null;'),
	'CardDAV discovery must support common same-origin well-known redirects, retain TLS verification, and fail cleanly without an undefined client.'
);

const indexTemplate = read('snappymail/v/0.0.0/app/templates/Index.html');
const service = read('snappymail/v/0.0.0/app/libraries/RainLoop/Service.php');
const audio = read('dev/Common/Audio.js');
const jsTask = read('tasks/js.js');
const openpgpV6 = read('vendors/openpgp-6/dist/openpgp.js');
assert(
	indexTemplate.includes('<script nonce=""')
		&& service.indexOf('static::setCSP($sScriptNonce);')
			< service.indexOf("str_replace('nonce=\"\"', 'nonce=\"'"),
	'CSP must issue a nonce in the header and inject the exact same nonce into the app boot script.'
);
assert(
	!audio.includes('window.AudioContext')
		&& !audio.includes('new audioCtx')
		&& audio.includes('audioUnlocked = false')
		&& audio.includes('player.play()?.catch(() => {})'),
	'Audio playback must wait for a real user gesture instead of eagerly constructing an AudioContext.'
);
assert(
	jsTask.includes('vendors/openpgp-6/dist/openpgp.js')
		&& openpgpV6.includes('OpenPGP.js v6.3.1')
		&& !openpgpV6.includes('asmjs'),
	'Browser crypto must use the current OpenPGP.js v6 build without the obsolete asm.js fallback.'
);
assert(
	keyservers.includes('static::wkdManifestUrls($domain, $deadline)')
		&& keyservers.includes('1 < static::wkdTimeoutSeconds($deadline)')
		&& keyservers.includes('static::wkdManifestTxtUrls($domain)')
		&& !keyservers.includes('/index.json";'),
	'After standard WKD fails, nonstandard manifest discovery must use only the fixed identity-domain TXT locator.'
);

assert(
	pgpActions.includes("GetActionParam('timeoutMs', 2000)")
		&& pgpActions.includes('Keyservers::wkd($email, \\max(500, \\min(5000')
		&& pgpActions.includes('DoPgpDiscoverPublicKey()'),
	'Browser public-key discovery must clamp and forward a bounded WKD timeout without importing into GnuPG.'
);

const httpRequest = read('snappymail/v/0.0.0/app/libraries/snappymail/http/request.php');
const httpCurl = read('snappymail/v/0.0.0/app/libraries/snappymail/http/request/curl.php');
assert(
	httpRequest.includes('$force_ipv4 = false')
		&& httpCurl.includes('$this->force_ipv4')
		&& httpCurl.includes('CURLOPT_IPRESOLVE')
		&& httpCurl.includes('CURL_IPRESOLVE_V4'),
	'HTTP cURL transport must support WKD-scoped IPv4 resolution for tunnel hosts whose IPv6 path is not reachable from the app container.'
);

const nginx = read('.docker/release/files/etc/nginx/nginx.conf');
assert(
	nginx.includes('no-store, no-cache, must-revalidate, max-age=0'),
	'Production nginx must keep SnappyMail assets non-cacheable while OpenPGP is under active repair.'
);
assert(
	!nginx.includes('expires 7d') && !nginx.includes('expires 30d') && !nginx.includes('Cache-Control "public"'),
	'Production nginx must not restore long-lived public caching for SnappyMail assets.'
);
assert(
	nginx.includes('location ^~ /.well-known/openpgpkey')
		&& nginx.includes('try_files $uri $uri/ /index.php?$uri&$args;'),
	'Production nginx must forward WKD paths through SnappyMail without losing the original path.'
);

const stack = read('deploy/snappymail-stack.yml');
for (const host of ['openpgpkey.boompay.ca', 'openpgpkey.nixc.us']) {
	assert(
		stack.includes(`Host(\`${host}\`) && PathPrefix(\`/.well-known/openpgpkey/\`)`),
		`${host} must route only the WKD namespace.`
	);
}

const serviceActions = read('snappymail/v/0.0.0/app/libraries/RainLoop/ServiceActions.php');
assert(
	serviceActions.includes('Wkd::manifest($domain, $baseUrl)')
		&& serviceActions.includes("Content-Type: application/json; charset=utf-8")
		&& serviceActions.includes('wellKnownHostMatchesWkd')
		&& serviceActions.includes('https://openpgpkey.{$domain}/.well-known/openpgpkey/{$domain}'),
	'WKD index.json must serve the hashed recipient manifest instead of returning 404.'
);
assert(
	!serviceActions.includes('MailSo\\Base\\Utils::jsonEncode'),
	'WKD manifest JSON must use the RainLoop Utils::jsonEncode helper available in ServiceActions.'
);
assert(
	serviceActions.includes('wellKnownNoStoreHeaders()')
		&& serviceActions.includes('no-store, no-cache, must-revalidate, max-age=0'),
	'WKD key and manifest responses must be explicitly non-cacheable.'
);
assert(
	!serviceActions.includes("if ((3 === \\count($paths) && 'index.json' === ($paths[2] ?? '')) {\n\t\t\treturn $this->wellKnownNotFound();"),
	'WKD index.json routes must not be hardcoded to 404.'
);

const compose = read('docker-compose.yml');
assert(
	(compose.match(/TUNNEL_HOST:\s*snappymail/g) || []).length === 4,
	'Each public SnappyMail tunnel must connect to the app by Compose DNS using TUNNEL_HOST=snappymail.'
);
assert(
	compose.includes('TUNNEL_DOMAIN: ${TUNNEL_DOMAIN:-mail.boompay.ca}')
		&& compose.includes('mail.boompay.ca=boompay'),
	'BoomPay mail host must be represented in the primary tunnel config and brand host mapping.'
);
assert(
	!compose.includes('network_mode: service:snappymail'),
	'Tunnel clients must not share the SnappyMail container network namespace; app recreates would strand the tunnels.'
);

const devLocal = read('scripts/dev-local.js');
const refreshTunnel = read('scripts/refresh-tunnel-if-running.js');
assert(
	!devLocal.includes('--force-recreate') && !refreshTunnel.includes('--force-recreate'),
	'Developer/test helpers must not force-recreate public tunnel clients.'
);
assert(
	refreshTunnel.includes('leaving them untouched'),
	'refresh-tunnel-if-running must preserve running tunnel clients after app rebuilds.'
);
assert(
	!devLocal.includes("'tunnel-client-mail-boompay-ca'")
		&& !refreshTunnel.includes("'tunnel-client-mail-boompay-ca'"),
	'Dev tunnel helpers must use only the primary BoomPay mail tunnel service.'
);

const branding = read('snappymail/v/0.0.0/app/libraries/snappymail/branding.php');
assert(
	branding.includes("'mail.boompay.ca' => 'boompay'"),
	'Runtime branding must map mail.boompay.ca to the BoomPay profile.'
);

const liveOpenPgpContract = read('tests/playwright/openpgp-send-contract.cjs');
const openPgpWorkflow = read('.github/workflows/openpgp-contract.yml');
assert(
	packageManifest.scripts['test:openpgp']
		&& packageManifest.scripts['test:openpgp:live']
		&& packageManifest.scripts['verify:openpgp']
		&& packageManifest.scripts['verify:openpgp'].includes('npm run test:static-build')
		&& packageManifest.scripts['verify:openpgp'].includes('npm run test:openpgp:live'),
	'OpenPGP must retain explicit fast, live, and full verification commands.'
);
assert(
	liveOpenPgpContract.includes('assertPublishedBundles')
		&& liveOpenPgpContract.includes('published-browser-bundles')
		&& liveOpenPgpContract.includes('writeReport')
		&& liveOpenPgpContract.includes('capturePageFailure')
		&& liveOpenPgpContract.includes("'nixc-to-boompay'")
		&& liveOpenPgpContract.includes("'boompay-to-nixc'")
		&& liveOpenPgpContract.includes("const protonWkdRecipient = 'contact@proton.me'")
		&& liveOpenPgpContract.includes('verifyZeroTouchProtonWkd')
		&& liveOpenPgpContract.includes("'proton-wkd-zero-touch'")
		&& liveOpenPgpContract.includes('recipient-packet-and-plaintext-policy-assertions')
		&& liveOpenPgpContract.includes('encryptionFailure')
		&& liveOpenPgpContract.includes('sent in plaintext')
		&& liveOpenPgpContract.includes('recipient-decrypt-and-plaintext-forward'),
	'Live OpenPGP verification must prove zero-touch Proton WKD, the public bundle, recipient policy, decrypt, forward, and emit a diagnostic report.'
);
assert(
	openPgpWorkflow.includes('npm run test:openpgp')
		&& openPgpWorkflow.includes('npx playwright install --with-deps chromium'),
	'CI must run deterministic OpenPGP contracts with Chromium available.'
);

console.log('OpenPGP regression checks passed');
