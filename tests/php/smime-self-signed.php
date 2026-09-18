<?php

$sourceRoot = getenv('SNAPPYMAIL_SOURCE_ROOT') ?: realpath(__DIR__ . '/../../snappymail');
require $sourceRoot . '/v/0.0.0/app/libraries/snappymail/sensitivestring.php';
require $sourceRoot . '/v/0.0.0/app/libraries/snappymail/smime/certificate.php';

// Only the application's log-mask sink is stubbed; crypto uses real OpenSSL.
class SMimeTestApi
{
	public static function Actions(): object
	{
		return new class {
			public function logMask(string $value): void {}
		};
	}
}
class_alias(SMimeTestApi::class, 'RainLoop\\Api');

function check(bool $result, string $message): void
{
	if (!$result) {
		throw new RuntimeException($message);
	}
}

$passphrase = new \SnappyMail\SensitiveString(bin2hex(random_bytes(24)));
$make = static function () {
	$cert = new \SnappyMail\SMime\Certificate();
	$cert->keyBits = 2048;
	$cert->distinguishedName = ['commonName' => 'S/MIME regression', 'emailAddress' => 'smime@example.test'];
	return $cert;
};
$first = $make()->createSelfSigned($passphrase);
$key = openssl_pkey_get_private($first['pkey'], (string) $passphrase);
check(false !== $key, 'Exported key must unlock with its passphrase');
check(false === @openssl_pkey_get_private($first['pkey'], 'incorrect'), 'Exported key must reject a wrong passphrase');
check(openssl_x509_check_private_key($first['x509'], $key), 'Certificate and private key must match');
$public = openssl_pkey_get_public($first['x509']);
check(1 === openssl_x509_verify($first['x509'], $public), 'Certificate must verify with its own public key');
$info = openssl_x509_parse($first['x509']);
check($info['issuer'] === $info['subject'], 'Certificate must be self-issued');
check('CA:FALSE' === $info['extensions']['basicConstraints'], 'Mail identity must not be a certificate authority');
check(str_contains($info['extensions']['extendedKeyUsage'], 'E-mail Protection'), 'Certificate must support S/MIME');
check('email:smime@example.test' === $info['extensions']['subjectAltName'], 'Certificate must preserve the email identity');

$second = $make()->createSelfSigned($passphrase);
check(!openssl_x509_check_private_key($second['x509'], $key), 'New identities must not share a signing key');
$renewed = $make()->createSelfSigned($passphrase, $first['pkey']);
check(openssl_x509_check_private_key($renewed['x509'], $key), 'Renewal must preserve a supplied private key');
check($renewed['pkey'] === $first['pkey'], 'Renewal must preserve encrypted key material');
try {
	$make()->createSelfSigned(new \SnappyMail\SensitiveString('incorrect'), $first['pkey']);
	throw new LogicException('An incorrect renewal passphrase was accepted');
} catch (RuntimeException $error) {
	check(str_starts_with($error->getMessage(), 'OpenSSL pkey:'), 'Renewal must fail at key validation');
}

$files = [];
try {
	foreach (['plain', 'encrypted', 'decrypted', 'signed', 'verified'] as $name) {
		$files[$name] = tempnam(sys_get_temp_dir(), 'smime-test-');
	}
	$body = "S/MIME encryption regression\r\n";
	file_put_contents($files['plain'], $body);
	check(openssl_pkcs7_encrypt($files['plain'], $files['encrypted'], $first['x509'], [], PKCS7_BINARY, OPENSSL_CIPHER_AES_256_CBC), 'S/MIME encryption must succeed');
	check(openssl_pkcs7_decrypt($files['encrypted'], $files['decrypted'], $renewed['x509'], $key), 'Renewed identity must decrypt existing S/MIME mail');
	check(file_get_contents($files['decrypted']) === $body, 'Decryption must preserve message content');
	check(openssl_pkcs7_sign($files['plain'], $files['signed'], $first['x509'], $key, [], PKCS7_DETACHED | PKCS7_BINARY), 'S/MIME signing must succeed');
	check(true === openssl_pkcs7_verify($files['signed'], PKCS7_NOVERIFY | PKCS7_BINARY, null, [], null, $files['verified']), 'S/MIME signature must verify without implying CA trust');
	check(file_get_contents($files['verified']) === $body, 'Verified message content must match');

	// Previously CA-issued identities keep their original certificate and key.
	$caKey = null;
	$caCsr = openssl_csr_new(['commonName' => 'Legacy test authority'], $caKey, ['private_key_bits' => 2048, 'digest_alg' => 'sha256']);
	$caCertificate = openssl_csr_sign($caCsr, null, $caKey, 1, ['digest_alg' => 'sha256']);
	$legacyKey = $key;
	$legacyCsr = openssl_csr_new($make()->distinguishedName, $legacyKey, ['digest_alg' => 'sha256']);
	$legacyCertificate = openssl_csr_sign($legacyCsr, $caCertificate, $caKey, 1, ['digest_alg' => 'sha256']);
	unset($caCsr, $caCertificate, $caKey);
	check(openssl_pkcs7_encrypt($files['plain'], $files['encrypted'], $legacyCertificate, [], PKCS7_BINARY, OPENSSL_CIPHER_AES_256_CBC), 'Legacy S/MIME encryption must succeed');
	check(openssl_pkcs7_decrypt($files['encrypted'], $files['decrypted'], $legacyCertificate, $key), 'Stored legacy certificate and key must decrypt without the CA signing key');
	check(file_get_contents($files['decrypted']) === $body, 'Legacy identity must retain mail readability');
} finally {
	foreach ($files as $file) {
		unlink($file);
	}
}
echo "S/MIME generation, renewal, signing and encryption passed\n";
