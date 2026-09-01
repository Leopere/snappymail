<?php

namespace RainLoop\Actions;

use SnappyMail\PGP\Backup;
use SnappyMail\PGP\Keyservers;
use SnappyMail\PGP\GnuPG;
use SnappyMail\PGP\Wkd;
use MailSo\Imap\Enumerations\FetchType;
use MailSo\Mime\Enumerations\Header as MimeEnumHeader;

trait Pgp
{
	private function clientVaultKeys($value, array $expected) : bool
	{
		if (!\is_array($value)) {
			return false;
		}
		$actual = \array_keys($value);
		\sort($actual);
		\sort($expected);
		return $actual === $expected;
	}

	private function clientVaultBase64Url($value, int $minBytes, int $maxBytes) : bool
	{
		if (!\is_string($value) || !\preg_match('/^[A-Za-z0-9_-]+$/D', $value)) {
			return false;
		}
		$padded = \strtr($value, '-_', '+/') . \str_repeat('=', (4 - \strlen($value) % 4) % 4);
		$decoded = \base64_decode($padded, true);
		return false !== $decoded && $minBytes <= \strlen($decoded) && $maxBytes >= \strlen($decoded);
	}

	private function clientVaultCipher($cipher) : bool
	{
		return $this->clientVaultKeys($cipher, ['name', 'iv', 'ciphertext'])
			&& 'AES-256-GCM' === ($cipher['name'] ?? '')
			&& $this->clientVaultBase64Url($cipher['iv'] ?? null, 12, 12)
			&& $this->clientVaultBase64Url($cipher['ciphertext'] ?? null, 17, 2 * 1024 * 1024);
	}

	private function clientVaultWrapper($wrapper) : bool
	{
		return $this->clientVaultKeys($wrapper, ['kdf', 'cipher'])
			&& $this->clientVaultKeys($wrapper['kdf'] ?? null, ['name', 'hash', 'iterations', 'salt'])
			&& 'PBKDF2-HMAC-SHA-256' === ($wrapper['kdf']['name'] ?? '')
			&& 'SHA-256' === ($wrapper['kdf']['hash'] ?? '')
			&& 600000 === ($wrapper['kdf']['iterations'] ?? 0)
			&& $this->clientVaultBase64Url($wrapper['kdf']['salt'] ?? null, 16, 16)
			&& $this->clientVaultCipher($wrapper['cipher']);
	}

	private function clientVaultPasswordWrapper($value) : ?array
	{
		if (!\is_string($value) || 64 * 1024 < \strlen($value)) {
			return null;
		}
		$wrapper = \json_decode($value, true);
		return $this->clientVaultWrapper($wrapper) ? $wrapper : null;
	}

	private function clientVault($value) : ?array
	{
		if (!\is_string($value) || 2 * 1024 * 1024 < \strlen($value)
			|| \str_contains($value, 'BEGIN PGP PRIVATE KEY')) {
			return null;
		}
		$vault = \json_decode($value, true);
		return \is_array($vault)
			&& $this->clientVaultKeys($vault, ['version', 'payload', 'wrappers'])
			&& 2 === ($vault['version'] ?? 0)
			&& $this->clientVaultCipher($vault['payload'] ?? null)
			&& $this->clientVaultKeys($vault['wrappers'] ?? null, ['password'])
			&& $this->clientVaultWrapper($vault['wrappers']['password'])
			? $vault : null;
	}

	private function clientVaultPublicKey($value) : string
	{
		$value = \trim((string) $value);
		return 0 < \strlen($value) && 128 * 1024 >= \strlen($value)
			&& !\str_contains($value, 'PGP PRIVATE KEY')
			&& \preg_match('/\A-----BEGIN PGP PUBLIC KEY BLOCK-----.+-----END PGP PUBLIC KEY BLOCK-----\z/sD', $value)
			? $value : '';
	}

	private function clientVaultRecord(\RainLoop\Model\Account $account) : ?array
	{
		return $this->clientVaultRecordFromRaw($account->Email(), $this->clientVaultRaw($account));
	}

	private function clientVaultRecordFromRaw(string $email, string $raw) : ?array
	{
		$record = \json_decode($raw, true);
		$keys = \is_array($record) ? \array_keys($record) : [];
		\sort($keys);
		$status = $record['status'] ?? 'active';
		$validKeys = ['publicKey', 'revision', 'vault', 'version'] === $keys
			|| ['publicKey', 'revision', 'status', 'vault', 'version'] === $keys;
		return \is_array($record)
			&& $validKeys
			&& 2 === ($record['version'] ?? 0)
			&& 0 < ($record['revision'] ?? 0)
			&& \in_array($status, ['active', 'quarantined'], true)
			&& $this->clientVault(\json_encode($record['vault']))
			&& $this->clientVaultPublicKey($record['publicKey'] ?? '')
			&& Wkd::publicKeyMatchesEmail($email, $record['publicKey'])
			? $record + ['status' => $status] : null;
	}

	private function clientVaultStorageOwner(\RainLoop\Model\Account $account) : string
	{
		$parts = Wkd::emailParts($account->Email());
		return $parts ? $parts[0] . '@' . $parts[1] : \strtolower($account->Email());
	}

	private function clientVaultRaw(\RainLoop\Model\Account $account) : string
	{
		return $this->clientVaultRawFromOwner($this->clientVaultStorageOwner($account));
	}

	private function clientVaultRawFromOwner($owner) : string
	{
		return (string) $this->StorageProvider()->Get(
			$owner,
			\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT,
			'.openpgp-client-vault',
			''
		);
	}

	private function clientVaultRawEmail(string $raw) : string
	{
		$record = \json_decode($raw, true);
		$publicKey = \is_array($record) ? $this->clientVaultPublicKey($record['publicKey'] ?? '') : '';
		$emails = $publicKey ? Wkd::publicKeyEmails($publicKey) : [];
		return 1 === \count($emails) ? $emails[0] : '';
	}

	/** Move an opaque vault written under the pre-mailbox owner without changing its bytes. */
	private function ensureClientVaultStorageOwner(\RainLoop\Model\Account $account) : bool
	{
		$storage = $this->StorageProvider();
		$storageType = \RainLoop\Providers\Storage\Enumerations\StorageType::ROOT;
		$canonicalOwner = $this->clientVaultStorageOwner($account);
		$canonicalRaw = $this->clientVaultRawFromOwner($canonicalOwner);
		if ($this->clientVaultRecordFromRaw($account->Email(), $canonicalRaw)) {
			return true;
		}

		$additional = $account instanceof \RainLoop\Model\AdditionalAccount;
		$sourceOwner = $canonicalOwner;
		$sourceRaw = $canonicalRaw;
		if ('' === \trim($sourceRaw)) {
			$legacyRaw = $this->clientVaultRawFromOwner($account);
			if ('' === \trim($legacyRaw)) {
				return true;
			}
			$sourceOwner = $account;
			$sourceRaw = $legacyRaw;
		}

		$recordEmail = $this->clientVaultRawEmail($sourceRaw);
		$accountParts = Wkd::emailParts($account->Email());
		$accountEmail = $accountParts ? $accountParts[0] . '@' . $accountParts[1] : '';
		if (!$recordEmail) {
			// An AdditionalAccount cannot safely attribute an unidentifiable parent record.
			if ($additional || '' !== \trim($canonicalRaw)) {
				return true;
			}
			// A mixed-case MainAccount legacy path still belongs to this exact account.
			$recordEmail = $accountEmail;
		}
		if ($additional && $recordEmail !== $accountEmail) {
			return true;
		}

		$targetOwner = $additional ? $canonicalOwner : $recordEmail;
		$targetRaw = $this->clientVaultRawFromOwner($targetOwner);
		if ('' !== \trim($targetRaw) && !\hash_equals($targetRaw, $sourceRaw)) {
			return false;
		}
		if ('' === \trim($targetRaw) && (!$storage->Put(
			$targetOwner, $storageType, '.openpgp-client-vault', $sourceRaw
		) || !\hash_equals($sourceRaw, $this->clientVaultRawFromOwner($targetOwner)))) {
			return false;
		}
		if (\is_string($sourceOwner) && $sourceOwner === $targetOwner) {
			return true;
		}
		if (!$storage->Clear($sourceOwner, $storageType, '.openpgp-client-vault')) {
			$this->logWrite('Copied a misplaced browser OpenPGP vault but could not remove its old owner path.', \LOG_ERR, 'OpenPGP');
			return false;
		}
		$this->logWrite('Moved a misplaced browser OpenPGP vault to its mailbox storage owner.', \LOG_NOTICE, 'OpenPGP');
		return true;
	}

	private function storeClientVaultRecord(\RainLoop\Model\Account $account, array $record) : bool
	{
		return $this->StorageProvider()->Put(
			$this->clientVaultStorageOwner($account),
			\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT,
			'.openpgp-client-vault',
			\json_encode($record, JSON_UNESCAPED_SLASHES)
		);
	}

	private function clientVaultPublicKeyPublished(\RainLoop\Model\Account $account, string $publicKey) : bool
	{
		try {
			return Wkd::publicKeyUsableForEmail($account->Email(), $publicKey)
				&& (Wkd::matches($account->Email(), $publicKey)
					|| Wkd::publish($account->Email(), $publicKey));
		} catch (\Throwable $e) {
			$this->logWrite('Browser OpenPGP WKD publication failed: ' . $e->getMessage(), \LOG_WARNING, 'OpenPGP');
			return false;
		}
	}

	private function restoreClientVaultRecord(\RainLoop\Model\Account $account, string $previous) : bool
	{
		$storage = $this->StorageProvider();
		return '' === $previous
			? $storage->Clear(
				$this->clientVaultStorageOwner($account),
				\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT,
				'.openpgp-client-vault'
			)
			: $storage->Put(
				$this->clientVaultStorageOwner($account),
				\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT,
				'.openpgp-client-vault',
				$previous
			);
	}

	/**
	 * The server stores an authenticated user's opaque browser-encrypted vault.
	 * It never decrypts, derives, or receives a vault secret or private key.
	 */
	public function DoPgpClientVaultGet() : array
	{
		return Wkd::transaction(fn() : array => $this->clientVaultGetTransaction());
	}

	private function clientVaultGetTransaction() : array
	{
		$account = $this->getAccountFromToken(false);
		if ($account && !$this->ensureClientVaultStorageOwner($account)) {
			return $this->FalseResponse();
		}
		$record = $account ? $this->clientVaultRecord($account) : null;
		$invalid = $account && '' !== \trim($this->clientVaultRaw($account)) && !$record;
		$quarantined = $record && 'quarantined' === $record['status'];
		$published = $record && !$quarantined
			&& $this->clientVaultPublicKeyPublished($account, $record['publicKey']);
		if ($quarantined && !Wkd::unpublish($account->Email())) {
			$this->logWrite('Quarantined browser OpenPGP key could not be withdrawn from WKD.', \LOG_ERR, 'OpenPGP');
		} else if ($record && !$published && !$quarantined) {
			$this->logWrite('Browser OpenPGP vault exists but its WKD public key is unavailable.', \LOG_WARNING, 'OpenPGP');
		}
		return $this->DefaultResponse([
			'record' => $record,
			'invalid' => !!$invalid,
			'published' => !!$published,
			'quarantined' => !!$quarantined
		]);
	}

	/**
	 * A browser calls this only after a real login password and the saved device
	 * wrapper both fail to unlock the private key. The encrypted vault remains
	 * recoverable, but its public key is withdrawn immediately.
	 */
	public function DoPgpClientVaultQuarantine() : array
	{
		return Wkd::transaction(fn() : array => $this->clientVaultQuarantineTransaction());
	}

	private function clientVaultQuarantineTransaction() : array
	{
		$account = $this->getAccountFromToken(false);
		if ($account && !$this->ensureClientVaultStorageOwner($account)) {
			return $this->FalseResponse();
		}
		$record = $account ? $this->clientVaultRecord($account) : null;
		if (!$account || !$record) {
			return $this->FalseResponse();
		}
		if ((int) $record['revision'] !== (int) $this->GetActionParam('expectedRevision', 0)) {
			return $this->DefaultResponse(['conflict' => true, 'revision' => (int) $record['revision']]);
		}
		if ('quarantined' === $record['status']) {
			Wkd::unpublish($account->Email());
			return $this->DefaultResponse($record + ['published' => false, 'quarantined' => true]);
		}

		$previous = $this->clientVaultRaw($account);
		$record['revision']++;
		$record['status'] = 'quarantined';
		if (!$this->storeClientVaultRecord($account, $record)) {
			return $this->FalseResponse();
		}
		if (!Wkd::unpublish($account->Email())) {
			$restored = $this->restoreClientVaultRecord($account, $previous);
			$this->logWrite(
				'Browser OpenPGP quarantine failed'
					. ($restored ? '; active vault state restored.' : '; active vault restoration failed.'),
				$restored ? \LOG_WARNING : \LOG_ERR,
				'OpenPGP'
			);
			return $this->FalseResponse();
		}
		$this->logWrite('Browser OpenPGP vault quarantined and its WKD key withdrawn.', \LOG_WARNING, 'OpenPGP');
		return $this->DefaultResponse($record + ['published' => false, 'quarantined' => true]);
	}

	/** Republish only after the browser has successfully unlocked the private key. */
	public function DoPgpClientVaultRestore() : array
	{
		return Wkd::transaction(fn() : array => $this->clientVaultRestoreTransaction());
	}

	private function clientVaultRestoreTransaction() : array
	{
		$account = $this->getAccountFromToken(false);
		if ($account && !$this->ensureClientVaultStorageOwner($account)) {
			return $this->FalseResponse();
		}
		$record = $account ? $this->clientVaultRecord($account) : null;
		if (!$account || !$record) {
			return $this->FalseResponse();
		}
		if ((int) $record['revision'] !== (int) $this->GetActionParam('expectedRevision', 0)) {
			return $this->DefaultResponse(['conflict' => true, 'revision' => (int) $record['revision']]);
		}
		if ('active' === $record['status']) {
			$published = $this->clientVaultPublicKeyPublished($account, $record['publicKey']);
			return $this->DefaultResponse($record + ['published' => $published, 'quarantined' => false]);
		}
		if (!$this->clientVaultPublicKeyPublished($account, $record['publicKey'])) {
			return $this->FalseResponse();
		}
		$record['revision']++;
		$record['status'] = 'active';
		if (!$this->storeClientVaultRecord($account, $record)) {
			$withdrawn = Wkd::unpublish($account->Email());
			$this->logWrite(
				'Browser OpenPGP restore could not persist active state'
					. ($withdrawn ? '; WKD publication withdrawn.' : '; WKD withdrawal failed.'),
				$withdrawn ? \LOG_WARNING : \LOG_ERR,
				'OpenPGP'
			);
			return $this->FalseResponse();
		}
		return $this->DefaultResponse($record + ['published' => true, 'quarantined' => false]);
	}

	public function DoPgpClientVaultPut() : array
	{
		return Wkd::transaction(fn() : array => $this->clientVaultPutTransaction());
	}

	/** Verify the current credential, then replace only the password wrapper. */
	public function DoPgpClientVaultPasswordPut() : array
	{
		$account = $this->getAccountFromToken(false);
		$wrapper = $this->clientVaultPasswordWrapper($this->GetActionParam('passwordWrapper', ''));
		$current = $account ? $this->clientVaultRecord($account) : null;
		$expectedRevision = (int) $this->GetActionParam('expectedRevision', 0);
		if (!$account || !$wrapper || !$current) {
			$this->logWrite('Rejected malformed browser OpenPGP password-wrapper update.', \LOG_WARNING, 'OpenPGP');
			return $this->FalseResponse();
		}
		$currentRevision = (int) $current['revision'];
		$alreadyApplied = $currentRevision === $expectedRevision + 1
			&& 'active' === $current['status']
			&& $current['vault']['wrappers']['password'] === $wrapper;
		if ($currentRevision !== $expectedRevision && !$alreadyApplied) {
			return $this->DefaultResponse(['conflict' => true, 'revision' => $currentRevision]);
		}
		$password = (string) $this->GetActionParam('Password', '');
		if ('' === $password || !\hash_equals($account->IncPassword(), $password)) {
			$this->loginErrorDelay();
			return $this->DefaultResponse(['valid' => false, 'signInRequired' => true]);
		}

		$imap = new \MailSo\Imap\ImapClient();
		$imap->SetLogger($this->Logger());
		try {
			$this->imapConnect($account, false, $imap, 8);
		} catch (\Throwable $error) {
			if ($error->getPrevious() instanceof \MailSo\Imap\Exceptions\LoginBadCredentialsException) {
				$this->loginErrorDelay();
				return $this->DefaultResponse(['valid' => false, 'signInRequired' => true]);
			}
			return $this->DefaultResponse(['valid' => false, 'unavailable' => true]);
		} finally {
			try {
				$imap->Disconnect();
			} catch (\Throwable $error) {
			}
		}

		return Wkd::transaction(fn() : array => $this->clientVaultPasswordPutTransaction(
			$account, $wrapper, $expectedRevision
		));
	}

	private function clientVaultPasswordPutTransaction(
		\RainLoop\Model\Account $account,
		array $wrapper,
		int $expectedRevision
	) : array
	{
		if (!$this->ensureClientVaultStorageOwner($account)) {
			return $this->FalseResponse();
		}
		$current = $this->clientVaultRecord($account);
		if (!$current) {
			return $this->FalseResponse();
		}
		$currentRevision = (int) $current['revision'];
		if ($currentRevision === $expectedRevision + 1
			&& 'active' === $current['status']
			&& $current['vault']['wrappers']['password'] === $wrapper) {
			$published = $this->clientVaultPublicKeyPublished($account, $current['publicKey']);
			return $published
				? $this->DefaultResponse($current + ['published' => true, 'quarantined' => false])
				: $this->DefaultResponse(['recoveryRequired' => true]);
		}
		if ($currentRevision !== $expectedRevision) {
			return $this->DefaultResponse(['conflict' => true, 'revision' => $currentRevision]);
		}

		$previous = $this->clientVaultRaw($account);
		$record = $current;
		$record['revision'] = $currentRevision + 1;
		$record['status'] = 'active';
		$record['vault']['wrappers']['password'] = $wrapper;
		if (!$this->storeClientVaultRecord($account, $record)) {
			$this->logWrite('Unable to persist browser OpenPGP password-wrapper update.', \LOG_WARNING, 'OpenPGP');
			return $this->FalseResponse();
		}
		if (!$this->clientVaultPublicKeyPublished($account, $record['publicKey'])) {
			$restored = $this->restoreClientVaultRecord($account, $previous);
			$this->logWrite(
				'Browser OpenPGP password-wrapper update rejected because WKD publication failed'
					. ($restored ? '; previous vault restored.' : '; previous vault restoration failed.'),
				$restored ? \LOG_WARNING : \LOG_ERR,
				'OpenPGP'
			);
			return $restored
				? $this->FalseResponse()
				: $this->DefaultResponse(['recoveryRequired' => true]);
		}
		return $this->DefaultResponse($record + ['published' => true, 'quarantined' => false]);
	}

	private function clientVaultPutTransaction() : array
	{
		$account = $this->getAccountFromToken(false);
		if ($account && !$this->ensureClientVaultStorageOwner($account)) {
			return $this->FalseResponse();
		}
		$vault = $this->clientVault($this->GetActionParam('vault', ''));
		$publicKey = $this->clientVaultPublicKey($this->GetActionParam('publicKey', ''));
		if (!$account || !$vault || !$publicKey) {
			$this->logWrite('Rejected malformed browser OpenPGP vault write.', \LOG_WARNING, 'OpenPGP');
			return $this->FalseResponse();
		}
		if (!Wkd::publicKeyUsableForEmail($account->Email(), $publicKey)) {
			$this->logWrite('Rejected browser OpenPGP key without one exact mailbox UID and usable signing/encryption capabilities.', \LOG_WARNING, 'OpenPGP');
			return $this->FalseResponse();
		}

		$previous = $this->clientVaultRaw($account);
		$current = $this->clientVaultRecord($account);
		$currentRevision = (int) ($current['revision'] ?? 0);
		if (!$current && '' !== \trim($previous)) {
			return $this->DefaultResponse([
				'conflict' => true,
				'invalid' => true,
				'revision' => 0
			]);
		}
		if ($currentRevision !== (int) $this->GetActionParam('expectedRevision', 0)) {
			return $this->DefaultResponse([
				'conflict' => true,
				'revision' => $currentRevision
			]);
		}

		$record = [
			'version' => 2,
			'revision' => $currentRevision + 1,
			'status' => 'active',
			'vault' => $vault,
			'publicKey' => $publicKey
		];
		$stored = $this->storeClientVaultRecord($account, $record);
		if (!$stored) {
			$this->logWrite('Unable to persist browser OpenPGP vault.', \LOG_WARNING, 'OpenPGP');
			return $this->FalseResponse();
		}
		if (!$this->clientVaultPublicKeyPublished($account, $publicKey)) {
			$restored = $this->restoreClientVaultRecord($account, $previous);
			$this->logWrite(
				'Browser OpenPGP vault rejected because WKD publication failed'
					. ($restored ? '; previous vault restored.' : '; previous vault restoration failed.'),
				$restored ? \LOG_WARNING : \LOG_ERR,
				'OpenPGP'
			);
			return $this->FalseResponse();
		}
		return $this->DefaultResponse($record + ['published' => true]);
	}

	/**
	 * Returns only the encrypted MIME part. OpenPGP decryption is browser-only.
	 */
	public function DoPgpFetchEncryptedMessage() : array
	{
		$folder = (string) $this->GetActionParam('folder', '');
		$uid = (int) $this->GetActionParam('uid', 0);
		$partId = \trim((string) $this->GetActionParam('partId', ''));
		if (!$folder || 0 >= $uid || !\preg_match('/^[0-9]+(?:\.[0-9]+)*$/D', $partId)) {
			return $this->FalseResponse();
		}

		$data = '';
		$this->initMailClientConnection();
		$this->MailClient()->MessageMimeStream(
			function ($resource) use (&$data) {
				if (\is_resource($resource)) {
					$data = (string) \stream_get_contents($resource);
				}
			},
			$folder,
			$uid,
			$partId
		);
		return $this->DefaultResponse($data ?: false);
	}

	/**
	 * WKD is a public-key lookup only. No result is imported into server GnuPG.
	 */
	public function DoPgpDiscoverPublicKey() : array
	{
		$parts = Wkd::emailParts($this->GetActionParam('email', ''));
		if (!$parts) {
			return $this->FalseResponse();
		}
		$email = $parts[0] . '@' . $parts[1];
		$key = Keyservers::wkd($email, \max(500, \min(5000, (int) $this->GetActionParam('timeoutMs', 2000))));
		return $this->DefaultResponse($key ? [
			'email' => $email,
			'key' => \base64_encode($key)
		] : false);
	}

	private function gnuPGKeyHasEmail(array $key, string $email) : bool
	{
		$parts = Wkd::emailParts($email);
		$email = $parts ? $parts[0] . '@' . $parts[1] : \strtolower($email);
		foreach (($key['uids'] ?? []) as $uid) {
			foreach (['email', 'uid', 'name'] as $field) {
				if (!empty($uid[$field]) && \preg_match('/[^\\s<>]+@[^\\s<>]+/', $uid[$field], $match)) {
					$uidParts = Wkd::emailParts($match[0]);
					if ($uidParts && $email === $uidParts[0] . '@' . $uidParts[1]) {
						return true;
					}
				}
			}
		}
		return false;
	}

	private function gnuPGPrivateKeysForEmail(array $keys, string $email) : array
	{
		return \array_values(\array_filter(
			$keys,
			fn($key) : bool => \is_array($key) && $this->gnuPGKeyHasEmail($key, $email)
		));
	}

	private function legacyMigrationState(bool $legacyHome, bool $inspected, array $keys, array $passphrases) : array
	{
		$inspectionFailed = $legacyHome && !$inspected;
		return [
			'detected' => $inspectionFailed || !empty($keys) || !empty($passphrases),
			'complete' => !$inspectionFailed
		];
	}

	/**
	 * Legacy-only input for exporting existing server keys. No current login or
	 * browser request can write this historical passphrase data.
	 */
	private function gnuPGPassphraseVault() : array
	{
		$oAccount = $this->getMainAccountFromToken(false);
		if (!$oAccount) {
			return [];
		}

		$data = $this->StorageProvider()->Get($oAccount, \RainLoop\Providers\Storage\Enumerations\StorageType::ROOT, '.gnupg-passphrases');
		$data = $data ? \SnappyMail\Crypt::DecryptFromJSON($data, $oAccount->CryptKey()) : null;
		return \is_array($data) ? $data : [];
	}

	private function gnuPGPassphraseCandidates(string $email = '') : array
	{
		$parts = Wkd::emailParts($email);
		$email = $parts ? $parts[0] . '@' . $parts[1] : '';
		$candidates = [];
		foreach ($this->gnuPGPassphraseVault() as $entry) {
			if (!\is_array($entry) || !\is_string($entry['passphrase'] ?? null) || '' === $entry['passphrase']) {
				continue;
			}
			if ($email && $email === ($entry['email'] ?? '')) {
				$candidates[] = $entry['passphrase'];
			}
		}
		foreach ($this->gnuPGPassphraseVault() as $entry) {
			if (\is_array($entry) && \is_string($entry['passphrase'] ?? null) && '' !== $entry['passphrase']) {
				$candidates[] = $entry['passphrase'];
			}
		}
		return \array_values(\array_unique($candidates));
	}

	private function gnuPGPassphraseEntriesForEmail(string $email) : array
	{
		$parts = Wkd::emailParts($email);
		$email = $parts ? $parts[0] . '@' . $parts[1] : '';
		return $email ? \array_values(\array_filter(
			$this->gnuPGPassphraseVault(),
			static function ($entry) use ($email) : bool {
				if (!\is_array($entry) || !\is_string($entry['email'] ?? null)) {
					return false;
				}
				$parts = Wkd::emailParts($entry['email']);
				return $parts && $email === $parts[0] . '@' . $parts[1];
			}
		)) : [];
	}

	/** Issue one short-lived export capability only in a fresh password-login response. */
	private function issueLegacyMigrationCapability(\RainLoop\Model\Account $account) : string
	{
		return Wkd::transaction(fn() : string => $this->issueLegacyMigrationCapabilityTransaction($account));
	}

	private function issueLegacyMigrationCapabilityTransaction(\RainLoop\Model\Account $account) : string
	{
		if (!$this->ensureClientVaultStorageOwner($account)) {
			return '';
		}
		if ('' !== \trim($this->clientVaultRaw($account))) {
			return '';
		}
		$session = \RainLoop\Utils::GetSessionToken(false);
		if (!$session) {
			return '';
		}
		$capability = \rtrim(\strtr(\base64_encode(\random_bytes(32)), '+/', '-_'), '=');
		$value = \json_encode([
			'version' => 1,
			'email' => $this->clientVaultStorageOwner($account),
			'legacyMigration' => \hash('sha256', $capability),
			'expires' => \time() + 180
		], JSON_UNESCAPED_SLASHES);
		return $value && $this->StorageProvider()->Put(
			$account,
			\RainLoop\Providers\Storage\Enumerations\StorageType::SESSION,
			$session,
			$value
		) ? $capability : '';
	}

	/** Consume the fresh-login capability before any legacy secret is exported. */
	private function consumeLegacyMigrationCapability(\RainLoop\Model\Account $account, string $capability) : bool
	{
		$session = \RainLoop\Utils::GetSessionToken(false);
		if (!$session || !\preg_match('/^[A-Za-z0-9_-]{43}$/D', $capability)) {
			return false;
		}
		$value = $this->StorageProvider()->Get(
			$account,
			\RainLoop\Providers\Storage\Enumerations\StorageType::SESSION,
			$session,
			''
		);
		$data = \is_string($value) ? \json_decode($value, true) : null;
		$valid = \is_array($data)
			&& 1 === ($data['version'] ?? 0)
			&& \is_string($data['email'] ?? null)
			&& \hash_equals($this->clientVaultStorageOwner($account), $data['email'])
			&& \is_string($data['legacyMigration'] ?? null)
			&& \is_int($data['expires'] ?? null)
			&& \time() <= $data['expires']
			&& \time() + 300 >= $data['expires']
			&& \hash_equals($data['legacyMigration'], \hash('sha256', $capability));
		return $valid && $this->StorageProvider()->Put(
			$account,
			\RainLoop\Providers\Storage\Enumerations\StorageType::SESSION,
			$session,
			'true'
		);
	}

	/**
	 * Encrypts one legacy export to a one-time browser public key in a fresh
	 * temporary keyring. The temporary keyring is always removed before return.
	 */
	private function legacyTransportEnvelope(string $publicKey, string $payload) : string
	{
		$temporaryHome = \rtrim(\sys_get_temp_dir(), '/') . '/sm-pgp-' . \bin2hex(\random_bytes(12));
		$transport = null;
		try {
			\MailSo\Base\Utils::mkdir($temporaryHome);
			$transport = GnuPG::getInstance($temporaryHome);
			if (!$transport || !$transport->import($publicKey)) {
				return '';
			}
			$fingerprint = '';
			$keys = $transport->allKeysInfo('')['public'] ?? [];
			if (1 !== \count($keys)) {
				return '';
			}
			$fingerprint = (string) ($keys[0]['subkeys'][0]['fingerprint'] ?? $keys[0]['subkeys'][0]['keyid'] ?? '');
			if (!$fingerprint) {
				return '';
			}
			$transport->setArmor(true);
			$transport->clearEncryptKeys();
			$transport->addEncryptKey($fingerprint);
			$envelope = $transport->encrypt($payload);
			return \is_string($envelope) && \str_contains($envelope, '-----BEGIN PGP MESSAGE-----')
				? $envelope : '';
		} catch (\Throwable $e) {
			return '';
		} finally {
			$transport?->clearEncryptKeys();
			unset($transport);
			if (\is_dir($temporaryHome) && !\is_link($temporaryHome)) {
				foreach (\glob($temporaryHome . '/*') ?: [] as $path) {
					if (!\is_dir($path) || \is_link($path)) {
						@\unlink($path);
					}
				}
				\MailSo\Base\Utils::RecRmDir($temporaryHome);
			}
		}
	}

	/**
	 * Transitional export only. Every legacy secret-key packet is placed in an
	 * OpenPGP envelope addressed to a one-time public key generated in browser.
	 */
	public function DoPgpLegacyProtectedKeyExport() : array
	{
		return Wkd::transaction(fn() : array => $this->pgpLegacyProtectedKeyExportTransaction());
	}

	private function pgpLegacyProtectedKeyExportTransaction() : array
	{
		$account = $this->getAccountFromToken(false);
		if ($account && !$this->ensureClientVaultStorageOwner($account)) {
			return $this->FalseResponse();
		}
		$transportPublicKey = $this->clientVaultPublicKey($this->GetActionParam('transportPublicKey', ''));
		$capability = (string) $this->GetActionParam('migrationToken', '');
		if (!$account || $this->clientVaultRecord($account) || !$transportPublicKey
			|| !Wkd::publicKeyUsableForEmail($account->Email(), $transportPublicKey)) {
			return $this->FalseResponse();
		}
		if (!$this->consumeLegacyMigrationCapability($account, $capability)) {
			return $this->FalseResponse();
		}
		$root = $account ? \rtrim($this->StorageProvider()->GenerateFilePath(
			$account,
			\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT
		), '/') : '';
		$legacyHome = $root && \is_dir($root . '/.gnupg');
		try {
			$GPG = $legacyHome ? $this->GnuPG() : null;
		} catch (\Throwable $e) {
			$GPG = null;
		}
		$keys = [];
		$privateKeys = $this->gnuPGPrivateKeysForEmail(
			$GPG ? ($GPG->allKeysInfo('')['private'] ?? []) : [],
			$account->Email()
		);
		$matchingPassphraseState = $this->gnuPGPassphraseEntriesForEmail($account->Email());
		$state = $this->legacyMigrationState($legacyHome, (bool) $GPG, $privateKeys, $matchingPassphraseState);
		$detected = $state['detected'];
		$complete = $state['complete'];
		if ($account && $GPG) {
			foreach ($privateKeys as $key) {
				$detected = true;
				$fingerprint = (string) ($key['subkeys'][0]['fingerprint'] ?? $key['subkeys'][0]['keyid'] ?? '');
				if (!$fingerprint) {
					$complete = false;
					continue;
				}
				$armored = '';
				$usedPassphrase = null;
				foreach (\array_merge([''], $this->gnuPGPassphraseCandidates($account->Email())) as $passphrase) try {
					$armored = $GPG->export($fingerprint, new \SnappyMail\SensitiveString($passphrase));
					if ($armored && \str_contains($armored, 'BEGIN PGP PRIVATE KEY')) {
						$usedPassphrase = $passphrase;
						break;
					}
				} catch (\Throwable $e) {
					// Try the next legacy passphrase candidate without logging secret-key material.
				}
				unset($passphrase);
				try {
					$publicKey = $armored ? (string) $GPG->export($fingerprint) : '';
				} catch (\Throwable $e) {
					$publicKey = '';
				}
				$parts = Wkd::emailParts($account->Email());
				$email = $parts ? $parts[0] . '@' . $parts[1] : '';
				$entry = null !== $usedPassphrase && $publicKey && $email
					&& \in_array($email, Wkd::publicKeyEmails($publicKey), true)
					? \json_encode([
						'version' => 1,
						'email' => $account->Email(),
						'fingerprint' => \strtoupper($fingerprint),
						'privateKey' => $armored,
						'passphrase' => $usedPassphrase
					], JSON_UNESCAPED_SLASHES) : '';
				$envelope = $entry ? $this->legacyTransportEnvelope($transportPublicKey, $entry) : '';
				if ($envelope) {
					$keys[\strtoupper($fingerprint)] = [
						'envelope' => $envelope,
						'publicKey' => $publicKey,
						'published' => Wkd::matches($account->Email(), $publicKey),
						'usable' => Wkd::publicKeyUsableForEmail($account->Email(), $publicKey)
					];
				} else {
					$complete = false;
				}
				$armored = $entry = $usedPassphrase = null;
			}
		}
		if ($detected && !$keys) {
			$complete = false;
		}
		$published = \array_filter($keys, static fn(array $key) : bool => $key['published'] && $key['usable']);
		$usable = \array_filter($keys, static fn(array $key) : bool => $key['usable']);
		$activeFingerprint = '';
		if (1 === \count($published)) {
			$activeFingerprint = (string) \array_key_first($published);
		} else if (!$published && 1 === \count($usable)) {
			$activeFingerprint = (string) \array_key_first($usable);
		} else if ($detected) {
			$complete = false;
		}
		$publicKey = $activeFingerprint ? $keys[$activeFingerprint]['publicKey'] : '';
		return $this->DefaultResponse([
			'keys' => \array_values(\array_column($keys, 'envelope')),
			'detected' => $detected,
			'complete' => $complete,
			'activeFingerprint' => $complete ? $activeFingerprint : '',
			'publicKey' => $complete ? $publicKey : ''
		]);
	}

	/**
	 * Legacy cleanup remains disabled until the server can verify browser key
	 * possession and old-message decryptability. Migration never deletes keys.
	 */
	public function DoPgpLegacyPrivateKeyPurge() : array
	{
		// Migration is deliberately non-destructive. A future purge must prove
		// browser possession and old-message decryptability before it can exist.
		return $this->FalseResponse();
	}

	public function DoGetPGPKeys() : array
	{
		$result = [];

		$keys = Backup::getKeys();
		foreach ($keys['public'] as $key) {
			$result[] = $key['value'];
		}
		return $this->DefaultResponse(\array_values(\array_unique($result)));
	}

	public function DoPgpSearchKey() : array
	{
		$result = Keyservers::get(
			$this->GetActionParam('query', '')
		);
		return $this->DefaultResponse($result ?: false);
	}

	/**
	 * @throws \MailSo\RuntimeException
	 */
	public function GnuPG() : ?\SnappyMail\PGP\PGPInterface
	{
		$oAccount = $this->getMainAccountFromToken();
		if (!$oAccount) {
			return null;
		}

		$homedir = \rtrim($this->StorageProvider()->GenerateFilePath(
			$oAccount,
			\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT
		), '/') . '/.gnupg';

		\MailSo\Base\Utils::mkdir($homedir);
		if (!\is_writable($homedir)) {
			throw new \Exception("gpg homedir '{$homedir}' not writable");
		}

		/**
		 * Workaround error: socket name for '/very/long/path/to/.gnupg/S.gpg-agent.extra' is too long
		 * BSD 4.4 max length = 104
		 */
		if (80 < \strlen($homedir)) {
			\clearstatcache();
			// First try a symbolic link
				$tmpdir = \sys_get_temp_dir() . '/snappymail';
//			if (\RainLoop\Utils::inOpenBasedir($tmpdir) &&
				\is_dir($tmpdir) || \mkdir($tmpdir, 0700);
				if (\is_dir($tmpdir) && \is_writable($tmpdir)) {
					$link = $tmpdir . '/' . \md5($homedir);
					if (\is_link($link) && !\file_exists($link)) {
						\unlink($link);
					}
					if (\is_link($link) || \symlink($homedir, $link)) {
						$homedir = $link;
					} else {
					$this->logWrite("symlink('{$homedir}', '{$link}') failed", \LOG_WARNING, 'GnuPG');
				}
			}
			// Else try ~/.gnupg/ + hash(email address)
			if (80 < \strlen($homedir)) {
				$tmpdir = ($_SERVER['HOME'] ?: \exec('echo ~') ?: \dirname(\getcwd())) . '/.gnupg/';
				if ($oAccount instanceof \RainLoop\Model\AdditionalAccount) {
					$tmpdir .= \sha1($oAccount->ParentEmail());
				} else {
					$tmpdir .= \sha1($oAccount->Email());
				}
//				if (\RainLoop\Utils::inOpenBasedir($tmpdir) &&
				if (\is_dir($tmpdir) || \is_link($tmpdir) || \symlink($homedir, $tmpdir) || \mkdir($tmpdir, 0700, true)) {
					$homedir = $tmpdir;
				}
			}
		}

		return GnuPG::getInstance($homedir);
	}

	public function DoGnupgDecrypt() : array
	{
		return $this->FalseResponse();
	}

	public function DoPgpDecryptFailureReport() : array
	{
		$clean = static function ($value, int $limit = 240) : string {
			$value = \preg_replace('/[^\x20-\x7E]/', '?', (string) $value);
			return \substr($value, 0, $limit);
		};

		$fields = [
			'folder=' . $clean($this->GetActionParam('folder', ''), 120),
			'uid=' . (int) $this->GetActionParam('uid', 0),
			'hash=' . $clean($this->GetActionParam('hash', ''), 120),
			'reason=' . $clean($this->GetActionParam('reason', ''), 80),
			'armoredBody=' . (int) (bool) $this->GetActionParam('armoredBody', 0),
			'pgpEncrypted=' . (int) (bool) $this->GetActionParam('pgpEncrypted', 0),
			'pgpDecrypted=' . (int) (bool) $this->GetActionParam('pgpDecrypted', 0)
		];

		$error = $clean($this->GetActionParam('error', ''), 240);
		if ($error) {
			$fields[] = 'error=' . $error;
		}

		$this->logWrite('OpenPGP browser decrypt failure: ' . \implode(' ', $fields), \LOG_WARNING, 'OpenPGP');
		return $this->TrueResponse();
	}

	public function DoGnupgGetKeys() : array
	{
		return $this->DefaultResponse([
			'public' => [],
			'private' => []
		]);
	}

	public function DoGnupgExportKey() : array
	{
		return $this->FalseResponse();
	}

	public function DoGnupgGenerateKey() : array
	{
		return $this->FalseResponse();
	}

	public function DoGnupgSavePassphrase() : array
	{
		return $this->FalseResponse();
	}

	public function DoGnupgDeleteKey() : array
	{
		return $this->FalseResponse();
	}

	public function DoPgpImportKey() : array
	{
		$sKey = $this->GetActionParam('key', '');
		return $this->DefaultResponse([
			'accepted' => !!$this->clientVaultPublicKey($sKey),
			'backup' => false,
			'gnuPG' => false
		]);
	}

	public function DoGnupgDiscoverKey() : array
	{
		return $this->FalseResponse();
	}

	/**
	 * Used to import keys in OpenPGP.js
	 * Handy when using multiple browsers
	 */
	public function DoGetStoredPGPKeys() : array
	{
		return $this->DefaultResponse(Backup::getKeys());
	}

	/**
	 * Used to store generated armored key pair from OpenPGP.js
	 * Handy when using multiple browsers
	 */
	public function DoPgpStoreKeyPair() : array
	{
		return $this->DefaultResponse([
			'onServer' => [false, false],
			'inGnuPG' => [false, false]
		]);
	}

	/**
	 * Used to store key from OpenPGP.js
	 * Handy when using multiple browsers
	 */
	public function DoStorePGPKey() : array
	{
		$key = $this->GetActionParam('key', '');
		$keyId = $this->GetActionParam('keyId', '');
		return $this->DefaultResponse(($key && $keyId && Backup::PGPKey($key, $keyId)));
	}

	/**
	 * https://datatracker.ietf.org/doc/html/rfc3156#section-5
	 */
	public function DoPgpVerifyMessage() : array
	{
		$sBodyPart = $this->GetActionParam('bodyPart', '');
		if ($sBodyPart) {
			$result = [
				'text' => \preg_replace('/\\r?\\n/su', "\r\n", $sBodyPart),
				'signature' => $this->GetActionParam('sigPart', '')
			];
		} else {
			$sFolderName = $this->GetActionParam('folder', '');
			$iUid = (int) $this->GetActionParam('uid', 0);
			$sPartId = $this->GetActionParam('partId', '');
			$sSigPartId = $this->GetActionParam('sigPartId', '');
//			$sMicAlg = $this->GetActionParam('micAlg', '');

			$this->initMailClientConnection();
			$oImapClient = $this->ImapClient();
			$oImapClient->FolderExamine($sFolderName);

			$aParts = [
				FetchType::BODY_PEEK.'['.$sPartId.']',
				// An empty section specification refers to the entire message, including the header.
				// But Dovecot does not return it with BODY.PEEK[1], so we also use BODY.PEEK[1.MIME].
				FetchType::BODY_PEEK.'['.$sPartId.'.MIME]'
			];
			if ($sSigPartId) {
				$aParts[] = FetchType::BODY_PEEK.'['.$sSigPartId.']';
			}

			$oFetchResponse = $oImapClient->Fetch($aParts, $iUid, true)[0];

			$sBodyMime = $oFetchResponse->GetFetchValue(FetchType::BODY.'['.$sPartId.'.MIME]');
			if ($sSigPartId) {
				$result = [
					'text' => \preg_replace('/\\r?\\n/su', "\r\n",
						$sBodyMime . $oFetchResponse->GetFetchValue(FetchType::BODY.'['.$sPartId.']')
					),
					'signature' => \preg_replace('/[^\x00-\x7F]/', '',
						$oFetchResponse->GetFetchValue(FetchType::BODY.'['.$sSigPartId.']')
					)
				];
			} else {
				// clearsigned text
				$result = [
					'text' => $oFetchResponse->GetFetchValue(FetchType::BODY.'['.$sPartId.']'),
					'signature' => ''
				];
				$decode = (new \MailSo\Mime\HeaderCollection($sBodyMime))->ValueByName(MimeEnumHeader::CONTENT_TRANSFER_ENCODING);
				if ('base64' === $decode) {
					$result['text'] = \base64_decode($result['text']);
				} else if ('quoted-printable' === $decode) {
					$result['text'] = \quoted_printable_decode($result['text']);
				}
			}
		}

		// The server only returns detached-signature material. Verification is browser-only.

		return $this->DefaultResponse($result);
	}
}
