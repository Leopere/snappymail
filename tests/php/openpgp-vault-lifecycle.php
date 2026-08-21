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

namespace RainLoop\Model {
	class Account
	{
		public function __construct(private string $email) {}
		public function Email() : string { return $this->email; }
	}
}

namespace RainLoop\Providers\Storage\Enumerations {
	abstract class StorageType { public const ROOT = 6; }
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
		public function Get($account, int $type, string $key, $default = false) { return $this->values[$key] ?? $default; }
		public function Put($account, int $type, string $key, string $value) : bool { $this->values[$key] = $value; return true; }
		public function Clear($account, int $type, string $key) : bool { unset($this->values[$key]); return true; }
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
	echo "OpenPGP vault quarantine lifecycle checks passed\n";
}
