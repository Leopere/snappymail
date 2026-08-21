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
		$record = \json_decode((string) $this->StorageProvider()->Get(
			$account,
			\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT,
			'.openpgp-client-vault',
			''
		), true);
		return \is_array($record)
			&& $this->clientVaultKeys($record, ['version', 'revision', 'vault', 'publicKey'])
			&& 2 === ($record['version'] ?? 0)
			&& 0 < ($record['revision'] ?? 0)
			&& $this->clientVault(\json_encode($record['vault']))
			&& $this->clientVaultPublicKey($record['publicKey'] ?? '')
			? $record : null;
	}

	private function clientVaultPublicKeyPublished(\RainLoop\Model\Account $account, string $publicKey) : bool
	{
		try {
			return Wkd::matches($account->Email(), $publicKey)
				|| Wkd::publish($account->Email(), $publicKey);
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
				$account,
				\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT,
				'.openpgp-client-vault'
			)
			: $storage->Put(
				$account,
				\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT,
				'.openpgp-client-vault',
				$previous
			);
	}

	private function discardLegacyPrivateKeyState(\RainLoop\Model\Account $account) : void
	{
		$this->StorageProvider()->Clear(
			$account,
			\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT,
			'.gnupg-passphrases'
		);
		$root = \rtrim($this->StorageProvider()->GenerateFilePath(
			$account,
			\RainLoop\Providers\Storage\Enumerations\StorageType::ROOT
		), '/');
		$homedir = $root . '/.gnupg';
		if (\is_dir($homedir) && !\is_link($homedir)) {
			\MailSo\Base\Utils::RecRmDir($homedir);
		}
		Backup::clearPrivateKeys();
	}

	/**
	 * The server stores an authenticated user's opaque browser-encrypted vault.
	 * It never decrypts, derives, or receives a vault secret or private key.
	 */
	public function DoPgpClientVaultGet() : array
	{
		$account = $this->getAccountFromToken(false);
		$record = $account ? $this->clientVaultRecord($account) : null;
		$published = $record && $this->clientVaultPublicKeyPublished($account, $record['publicKey']);
		if ($record && !$published) {
			$this->logWrite('Browser OpenPGP vault exists but its WKD public key is unavailable.', \LOG_WARNING, 'OpenPGP');
		}
		return $this->DefaultResponse([
			'record' => $record,
			'published' => !!$published
		]);
	}

	public function DoPgpClientVaultPut() : array
	{
		$account = $this->getAccountFromToken(false);
		$vault = $this->clientVault($this->GetActionParam('vault', ''));
		$publicKey = $this->clientVaultPublicKey($this->GetActionParam('publicKey', ''));
		if (!$account || !$vault || !$publicKey) {
			$this->logWrite('Rejected malformed browser OpenPGP vault write.', \LOG_WARNING, 'OpenPGP');
			return $this->FalseResponse();
		}

		$storage = $this->StorageProvider();
		$storageType = \RainLoop\Providers\Storage\Enumerations\StorageType::ROOT;
		$previous = (string) $storage->Get($account, $storageType, '.openpgp-client-vault', '');
		$current = $this->clientVaultRecord($account);
		$currentRevision = (int) ($current['revision'] ?? 0);
		if ($currentRevision !== (int) $this->GetActionParam('expectedRevision', 0)) {
			return $this->DefaultResponse([
				'conflict' => true,
				'revision' => $currentRevision
			]);
		}

		$record = [
			'version' => 2,
			'revision' => $currentRevision + 1,
			'vault' => $vault,
			'publicKey' => $publicKey
		];
		$stored = $storage->Put(
			$account,
			$storageType,
			'.openpgp-client-vault',
			\json_encode($record, JSON_UNESCAPED_SLASHES)
		);
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
		if (0 === $currentRevision) {
			// This deployment starts with newly generated browser-only identities.
			$this->discardLegacyPrivateKeyState($account);
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

	/**
	 * Encrypts one legacy export to a one-time browser public key in a fresh
	 * temporary keyring. The temporary keyring is always removed before return.
	 */
	private function legacyTransportEnvelope(string $publicKey, string $privateArmor) : string
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
			foreach (($transport->allKeysInfo('')['public'] ?? []) as $key) {
				$fingerprint = (string) ($key['subkeys'][0]['fingerprint'] ?? $key['subkeys'][0]['keyid'] ?? '');
				if ($fingerprint) {
					break;
				}
			}
			if (!$fingerprint) {
				return '';
			}
			$transport->setArmor(true);
			$transport->clearEncryptKeys();
			$transport->addEncryptKey($fingerprint);
			$envelope = $transport->encrypt($privateArmor);
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
		$account = $this->getAccountFromToken(false);
		$transportPublicKey = $this->clientVaultPublicKey($this->GetActionParam('transportPublicKey', ''));
		if (!$account || !$transportPublicKey) {
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
		$detected = $legacyHome && !$GPG;
		$complete = !$detected;
		if ($account && $GPG) {
			foreach (($GPG->allKeysInfo('')['private'] ?? []) as $key) {
				if (!$this->gnuPGKeyHasEmail($key, $account->Email())) {
					continue;
				}
				$detected = true;
				$fingerprint = (string) ($key['subkeys'][0]['fingerprint'] ?? $key['subkeys'][0]['keyid'] ?? '');
				if (!$fingerprint) {
					$complete = false;
					continue;
				}
				$armored = '';
				foreach (\array_merge($this->gnuPGPassphraseCandidates($account->Email()), ['']) as $passphrase) try {
					$armored = $GPG->export($fingerprint, new \SnappyMail\SensitiveString($passphrase));
					if ($armored && \str_contains($armored, 'BEGIN PGP PRIVATE KEY')) {
						break;
					}
				} catch (\Throwable $e) {
					// Try the next legacy passphrase candidate without logging secret-key material.
				}
				$envelope = $armored
					? $this->legacyTransportEnvelope($transportPublicKey, $armored) : '';
				if ($envelope) {
					$keys[] = $envelope;
				} else {
					$complete = false;
				}
			}
		}
		return $this->DefaultResponse([
			'keys' => $keys,
			'detected' => $detected,
			'complete' => $complete
		]);
	}

	/**
	 * Removes only legacy private-key state after the user has verified the
	 * browser vault. Mail, account settings, public WKD output, and tunnels are
	 * intentionally outside this operation.
	 */
	public function DoPgpLegacyPrivateKeyPurge() : array
	{
		$account = $this->getAccountFromToken(false);
		if (!$account || 'PURGE_LEGACY_PRIVATE_KEYS' !== $this->GetActionParam('confirm', '')) {
			return $this->FalseResponse();
		}
		$record = $this->clientVaultRecord($account);
		if (!$record || !$this->clientVaultPublicKeyPublished($account, $record['publicKey'])) {
			return $this->FalseResponse();
		}

		$this->discardLegacyPrivateKeyState($account);
		$this->logWrite('Legacy server OpenPGP private key state removed for ' . $account->Email(), \LOG_NOTICE, 'OpenPGP');
		return $this->TrueResponse();
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
