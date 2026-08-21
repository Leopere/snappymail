<?php

declare(strict_types=1);

namespace MailSo\Base {
	abstract class Utils
	{
		public static function mkdir(string $directory) : void
		{
			if (!\is_dir($directory) && !\mkdir($directory, 0700, true) && !\is_dir($directory)) {
				throw new \RuntimeException("Unable to create {$directory}");
			}
		}
	}
}

namespace RainLoop {
	abstract class Utils
	{
		public static function GetSessionToken(bool $create = true) : string { return 'vault-lifecycle-session'; }
	}
}

namespace RainLoop\Model {
	class Account
	{
		public function __construct(private string $email) {}
		public function Email() : string { return $this->email; }
	}
	class MainAccount extends Account {}
	class AdditionalAccount extends Account
	{
		public function __construct(string $email, private string $parentEmail) { parent::__construct($email); }
		public function ParentEmail() : string { return $this->parentEmail; }
	}
}

namespace RainLoop\Providers\Storage\Enumerations {
	abstract class StorageType { public const ROOT = 6; public const SESSION = 3; }
}

namespace {
	$sourceRoot = \getenv('SNAPPYMAIL_SOURCE_ROOT') ?: \dirname(__DIR__, 2) . '/snappymail';
	\define('APP_PRIVATE_DATA', \sys_get_temp_dir() . '/snappymail-vault-lifecycle-' . \bin2hex(\random_bytes(8)) . '/');
	require $sourceRoot . '/v/0.0.0/app/libraries/snappymail/pgp/wkd.php';
	require $sourceRoot . '/v/0.0.0/app/libraries/RainLoop/Actions/Pgp.php';
}

namespace RainLoop\Actions {
	final class VaultLifecycleStorage
	{
		public array $values = [];
		public array $owners = [];
		public bool $separateAccountRoots = false;
		public string $parentVault = '';
		public bool $vaultsByOwner = false;
		public array $vaultValues = [];
		private function owner($account) : string {
			return \is_string($account) ? $account
				: ($account instanceof \RainLoop\Model\AdditionalAccount ? $account->ParentEmail() : $account->Email());
		}
		private function recordOwner($account) : void { $this->owners[] = \is_string($account) ? $account : $account->Email(); }
		public function Get($account, int $type, string $key, $default = false) {
			$this->recordOwner($account);
			if ($this->vaultsByOwner && '.openpgp-client-vault' === $key) {
				return $this->vaultValues[$this->owner($account)] ?? $default;
			}
			return $this->separateAccountRoots && !\is_string($account) && '.openpgp-client-vault' === $key
				? $this->parentVault : ($this->values[$key] ?? $default);
		}
		public function Put($account, int $type, string $key, string $value) : bool {
			$this->recordOwner($account);
			if ($this->vaultsByOwner && '.openpgp-client-vault' === $key) {
				$this->vaultValues[$this->owner($account)] = $value;
			} else {
				$this->values[$key] = $value;
			}
			return true;
		}
		public function Clear($account, int $type, string $key) : bool {
			$this->recordOwner($account);
			if ($this->vaultsByOwner && '.openpgp-client-vault' === $key) {
				$owner = $this->owner($account);
				if (!isset($this->vaultValues[$owner])) return false;
				unset($this->vaultValues[$owner]);
			} else {
				unset($this->values[$key]);
			}
			return true;
		}
		public function GenerateFilePath($account, int $type, bool $create = false) : string { return ''; }
	}

	final class VaultLifecycleActions
	{
		use Pgp;
		public array $params = [];
		public function __construct(private \RainLoop\Model\Account $account, private VaultLifecycleStorage $storage) {}
		protected function getAccountFromToken(bool $throw = true) { return $this->account; }
		public function StorageProvider() : VaultLifecycleStorage { return $this->storage; }
		protected function GetActionParam(string $name, $default = null) { return $this->params[$name] ?? $default; }
		protected function DefaultResponse($result) : array { return ['Result' => $result]; }
		protected function FalseResponse() : array { return ['Result' => false]; }
		protected function logWrite(...$arguments) : void {}
		public function issueMigrationCapability() : string { return $this->issueLegacyMigrationCapability($this->account); }
		public function consumeMigrationCapability(string $capability) : bool
		{
			return $this->consumeLegacyMigrationCapability($this->account, $capability);
		}
		public function ensureStorageOwner() : bool { return $this->ensureClientVaultStorageOwner($this->account); }
		public function legacyState(bool $home, bool $inspected, array $keys, array $passphrases) : array
		{
			return $this->legacyMigrationState($home, $inspected, $keys, $passphrases);
		}
		public function matchingLegacyKeys(array $keys, string $email) : array
		{
			return $this->gnuPGPrivateKeysForEmail($keys, $email);
		}
	}
}

namespace {
	$removeTree = static function (string $path) use (&$removeTree) : void {
		if (\is_file($path) || \is_link($path)) { \unlink($path); return; }
		if (\is_dir($path)) {
			foreach (\array_diff(\scandir($path) ?: [], ['.', '..']) as $name) $removeTree($path . '/' . $name);
			\rmdir($path);
		}
	};
	\register_shutdown_function($removeTree, APP_PRIVATE_DATA);
	$assert = static function (bool $condition, string $message) : void {
		if (!$condition) throw new \RuntimeException($message);
	};
	$email = 'security@vault-lifecycle.example.test';
	$publicKey = <<<'PGP'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEaoiv8hYJKwYBBAHaRw8BAQdA4iRKZY/pcf8eE3Zzo+gRxF4Q5sZ2trfvE47p
EW6edsm0MFNlY3VyaXR5IDxzZWN1cml0eUB2YXVsdC1saWZlY3ljbGUuZXhhbXBs
ZS50ZXN0PoivBBMWCgBXFiEEXO4HZFCBtSSteBEOzX86m0S+/AcFAmqIr/IbFIAA
AAAABAAObWFudTIsMi41KzEuMTIsMCwzAhsDBQsJCAcCAiICBhUKCQgLAgQWAgMB
Ah4HAheAAAoJEM1/OptEvvwHmUoBALAxZPOIRUUHahKGfRr9fX/lFtGSddg6GW/Q
PkgIrft6AQCKYUD4Vzc47D/6nr2tw7NO9E1TYrmKBFq0yEOMVHJyC7g4BGqIr/IS
CisGAQQBl1UBBQEBB0ATh8qeV61Yt2AHaJwC+qcYOmDTzYb+S0NuABpipMoGSQMB
CAeIlAQYFgoAPBYhBFzuB2RQgbUkrXgRDs1/OptEvvwHBQJqiK/yGxSAAAAAAAQA
Dm1hbnUyLDIuNSsxLjEyLDAsMwIbDAAKCRDNfzqbRL78B48DAQCMlY00F5xAtH3i
E198SIZPeMjdXbpZ2LAjpkj+EJOglwD8CoHOG/Hsy2RgFpZg4/iw3uHPwWnFGpT/
I9fwNo/0JAU=
=G40F
-----END PGP PUBLIC KEY BLOCK-----
PGP;
	$encoded = static fn(int $length) : string => \rtrim(\strtr(\base64_encode(\str_repeat('x', $length)), '+/', '-_'), '=');
	$vault = [
		'version' => 2,
		'payload' => ['name' => 'AES-256-GCM', 'iv' => $encoded(12), 'ciphertext' => $encoded(17)],
		'wrappers' => ['password' => [
			'kdf' => ['name' => 'PBKDF2-HMAC-SHA-256', 'hash' => 'SHA-256', 'iterations' => 600000, 'salt' => $encoded(16)],
			'cipher' => ['name' => 'AES-256-GCM', 'iv' => $encoded(12), 'ciphertext' => $encoded(17)]
		]]
	];
	$record = ['version' => 2, 'revision' => 1, 'status' => 'active', 'vault' => $vault, 'publicKey' => $publicKey];
	$storage = new \RainLoop\Actions\VaultLifecycleStorage();
	$storage->values['.openpgp-client-vault'] = \json_encode($record, JSON_UNESCAPED_SLASHES);
	$account = new \RainLoop\Model\Account($email);
	$actions = new \RainLoop\Actions\VaultLifecycleActions($account, $storage);
	$assert(\SnappyMail\PGP\Wkd::publish($email, $publicKey), 'Lifecycle fixture WKD publication failed.');

	$actions->params = ['expectedRevision' => 1];
	$quarantined = $actions->DoPgpClientVaultQuarantine()['Result'];
	$assert(true === $quarantined['quarantined'] && false === $quarantined['published']
		&& 2 === $quarantined['revision'] && 'quarantined' === $quarantined['status'],
		'Unlock failure must persist a revisioned quarantine state.');
	$assert(!\SnappyMail\PGP\Wkd::matches($email, $publicKey),
		'Quarantine must withdraw both the WKD object and manifest entry.');
	$get = $actions->DoPgpClientVaultGet()['Result'];
	$assert(true === $get['quarantined'] && false === $get['published'],
		'A quarantined vault must never be republished by a read.');

	$actions->params = ['expectedRevision' => 1];
	$assert(true === $actions->DoPgpClientVaultRestore()['Result']['conflict'],
		'A stale browser must not restore a changed vault revision.');
	$actions->params = ['expectedRevision' => 2];
	$restored = $actions->DoPgpClientVaultRestore()['Result'];
	$assert(true === $restored['published'] && false === $restored['quarantined']
		&& 3 === $restored['revision'] && 'active' === $restored['status'],
		'A successful private-key recovery must restore a revisioned active state.');
	$assert(\SnappyMail\PGP\Wkd::matches($email, $publicKey),
		'Restore must republish the exact mailbox-bound key.');
	$rollbackRaw = $storage->values['.openpgp-client-vault'];
	$rollbackManifest = \SnappyMail\PGP\Wkd::manifestPath('vault-lifecycle.example.test');
	\unlink($rollbackManifest);
	\mkdir($rollbackManifest, 0700);
	$storage->separateAccountRoots = true;
	$storage->parentVault = '';
	$actions->params = ['expectedRevision' => 3];
	$assert(false === $actions->DoPgpClientVaultQuarantine()['Result']
		&& $rollbackRaw === $storage->values['.openpgp-client-vault'],
		'Failed AdditionalAccount quarantine must restore its own vault bytes, never the parent root.');
	$storage->separateAccountRoots = false;
	\rmdir($rollbackManifest);
	$assert(\SnappyMail\PGP\Wkd::publish($email, $publicKey),
		'Lifecycle fixture must republish after the forced quarantine rollback failure.');

	$storage->Clear($account, \RainLoop\Providers\Storage\Enumerations\StorageType::ROOT, '.openpgp-client-vault');
	$storage->values['.gnupg-passphrases'] = 'legacy-state-must-survive';
	$actions->params = [
		'expectedRevision' => 0,
		'vault' => \json_encode($vault, JSON_UNESCAPED_SLASHES),
		'publicKey' => $publicKey
	];
	$created = $actions->DoPgpClientVaultPut()['Result'];
	$assert(1 === $created['revision'] && true === $created['published'],
		'A missing vault must be created and published atomically.');
	$assert('legacy-state-must-survive' === $storage->values['.gnupg-passphrases'],
		'First vault persistence must not delete recoverable legacy key state.');
	$assert(\in_array($email, $storage->owners, true),
		'Vault records must be stored under the active mailbox, including additional accounts.');
	$actions->params = ['confirm' => 'PURGE_LEGACY_PRIVATE_KEYS'];
	$assert(false === $actions->DoPgpLegacyPrivateKeyPurge()['Result'],
		'Legacy cleanup must stay disabled until private-key possession and old-message decryption can be verified.');
	$storage->Clear($account, \RainLoop\Providers\Storage\Enumerations\StorageType::ROOT, '.openpgp-client-vault');
	$capability = $actions->issueMigrationCapability();
	$sessionValue = $storage->values['vault-lifecycle-session'] ?? '';
	$assert(1 === \preg_match('/^[A-Za-z0-9_-]{43}$/D', $capability)
		&& !\str_contains($sessionValue, $capability)
		&& $email === (\json_decode($sessionValue, true)['email'] ?? ''),
		'A fresh login must store only the hash of a short-lived capability bound to that mailbox.');
	$otherActions = new \RainLoop\Actions\VaultLifecycleActions(
		new \RainLoop\Model\AdditionalAccount('other@vault-lifecycle.example.test', $email), $storage
	);
	$assert(false === $otherActions->consumeMigrationCapability($capability),
		'An AdditionalAccount must not consume another mailbox migration capability.');
	$assert(false === $actions->consumeMigrationCapability(\str_repeat('x', 43)),
		'An incorrect legacy-export capability must be rejected without consuming the valid one.');
	$assert(true === $actions->consumeMigrationCapability($capability)
		&& false === $actions->consumeMigrationCapability($capability),
		'A valid legacy-export capability must be accepted exactly once.');

	$malformed = '{"version":2,"truncated":true}';
	$storage->values['.openpgp-client-vault'] = $malformed;
	$get = $actions->DoPgpClientVaultGet()['Result'];
	$assert(null === $get['record'] && true === $get['invalid'],
		'A malformed existing vault must be reported as invalid, never missing.');
	$actions->params = [
		'expectedRevision' => 0,
		'vault' => \json_encode($vault, JSON_UNESCAPED_SLASHES),
		'publicKey' => $publicKey
	];
	$conflict = $actions->DoPgpClientVaultPut()['Result'];
	$assert(true === $conflict['conflict'] && true === $conflict['invalid']
		&& $malformed === $storage->values['.openpgp-client-vault'],
		'A malformed existing vault must remain byte-for-byte intact and reject revision-zero overwrite.');

	$additionalEmail = 'security@vault-lifecycle.example.test';
	$parentEmail = 'parent@vault-lifecycle.example.test';
	$foreignStorage = new \RainLoop\Actions\VaultLifecycleStorage();
	$foreignStorage->vaultsByOwner = true;
	$foreignStorage->vaultValues[$parentEmail] = $rollbackRaw;
	$foreignActions = new \RainLoop\Actions\VaultLifecycleActions(
		new \RainLoop\Model\MainAccount($parentEmail), $foreignStorage
	);
	$assert($foreignActions->ensureStorageOwner()
		&& $rollbackRaw === ($foreignStorage->vaultValues[$additionalEmail] ?? '')
		&& !isset($foreignStorage->vaultValues[$parentEmail]),
		'A main login must relocate a previously parent-owned AdditionalAccount vault before bootstrap.');

	$ownerStorage = new \RainLoop\Actions\VaultLifecycleStorage();
	$ownerStorage->vaultsByOwner = true;
	$ownerStorage->vaultValues[$parentEmail] = $rollbackRaw;
	$additional = new \RainLoop\Model\AdditionalAccount($additionalEmail, $parentEmail);
	$additionalActions = new \RainLoop\Actions\VaultLifecycleActions($additional, $ownerStorage);
	$assert($additionalActions->ensureStorageOwner()
		&& $rollbackRaw === ($ownerStorage->vaultValues[$additionalEmail] ?? '')
		&& !isset($ownerStorage->vaultValues[$parentEmail]),
		'An existing AdditionalAccount vault must move byte-for-byte from its parent root to its mailbox owner.');

	$mixedCaseEmail = 'Security@vault-lifecycle.example.test';
	$mixedStorage = new \RainLoop\Actions\VaultLifecycleStorage();
	$mixedStorage->vaultsByOwner = true;
	$mixedStorage->vaultValues[$mixedCaseEmail] = $rollbackRaw;
	$mixedActions = new \RainLoop\Actions\VaultLifecycleActions(
		new \RainLoop\Model\MainAccount($mixedCaseEmail), $mixedStorage
	);
	$assert($mixedActions->ensureStorageOwner()
		&& $rollbackRaw === ($mixedStorage->vaultValues[\strtolower($mixedCaseEmail)] ?? '')
		&& !isset($mixedStorage->vaultValues[$mixedCaseEmail]),
		'A mixed-case legacy owner path must move without changing the opaque v2 vault.');

	$parentKey = ['uids' => [['email' => $parentEmail]]];
	$additionalKey = ['uids' => [['email' => $additionalEmail]]];
	$assert([] === $additionalActions->matchingLegacyKeys([$parentKey], $additionalEmail)
		&& 1 === \count($additionalActions->matchingLegacyKeys([$parentKey, $additionalKey], $additionalEmail)),
		'Legacy key detection must consider only keys bound to the active mailbox.');
	$assert(['detected' => false, 'complete' => true] === $additionalActions->legacyState(true, true, [], [])
		&& ['detected' => true, 'complete' => false] === $additionalActions->legacyState(true, false, [], []),
		'An inspected empty or shared parent keyring must not block creation, while failed inspection remains fail-closed.');
	echo "OpenPGP vault quarantine lifecycle checks passed\n";
}
