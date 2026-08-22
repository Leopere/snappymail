<?php
// Copyright © 2026 ColinKnapp.com. All rights reserved.

$sourceRoot = \getenv('SNAPPYMAIL_SOURCE_ROOT') ?: \realpath(__DIR__ . '/../../snappymail');
if (!$sourceRoot) {
	fwrite(STDERR, "SnappyMail source root is unavailable\n");
	exit(1);
}

require $sourceRoot . '/v/0.0.0/app/libraries/snappymail/idn.php';

$forcedIcuFailure = '1' === \getenv('SNAPPYMAIL_EXPECT_ICU_FAILURE');
$cases = [
	[static fn(string $value): string => \SnappyMail\IDN::toAscii($value), 'BOOMPAY.CA', 'boompay.ca', 'ASCII domain normalization'],
	[static fn(string $value): string => \SnappyMail\IDN::toAscii($value), '*', '*', 'global wildcard normalization'],
	[static fn(string $value): string => \SnappyMail\IDN::toAscii($value), '*.BOOMPAY.CA', '*.boompay.ca', 'ASCII wildcard normalization'],
	[static fn(string $value): string => \SnappyMail\IDN::emailToAscii($value), 'Security@BOOMPAY.CA', 'Security@boompay.ca', 'ASCII mailbox normalization'],
	[static fn(string $value): string => \SnappyMail\IDN::emailToAscii($value), 'security', 'security', 'domainless login compatibility'],
	[static fn(string $value): string => \SnappyMail\IDN::emailToAscii($value), 'security@', '', 'empty-domain rejection'],
	[static fn(string $value): string => \SnappyMail\IDN::emailToAscii($value), 'security@' . \str_repeat('a', 64) . '.example', '', 'invalid IDN rejection'],
];

foreach ($cases as [$normalize, $input, $expected, $label]) {
	$actual = $normalize($input);
	if ($actual !== $expected) {
		fwrite(STDERR, "{$label} failed: " . \var_export($actual, true) . " !== " . \var_export($expected, true) . "\n");
		exit(1);
	}
}

if ($forcedIcuFailure) {
	if (false !== \idn_to_ascii('boompay.ca')) {
		fwrite(STDERR, "ICU failure fixture did not disable conversion\n");
		exit(1);
	}
	if ('' !== \SnappyMail\IDN::emailToAscii('security@bücher.example')) {
		fwrite(STDERR, "A failed Unicode conversion must reject the whole mailbox\n");
		exit(1);
	}
	if ('' !== \SnappyMail\IDN::toAscii('security@bücher.example')) {
		fwrite(STDERR, "Generic IDN normalization must not return a partial mailbox\n");
		exit(1);
	}
	if ('security@boompay.ca' !== \SnappyMail\IDN::emailToUtf8('security@boompay.ca')) {
		fwrite(STDERR, "An ASCII mailbox must not depend on ICU for display\n");
		exit(1);
	}
	if ('' !== \SnappyMail\IDN::emailToUtf8('security@xn--bcher-kva.example')) {
		fwrite(STDERR, "A failed punycode conversion must reject the whole mailbox\n");
		exit(1);
	}
} else {
	$ascii = \SnappyMail\IDN::emailToAscii('security@bücher.example');
	if ('security@xn--bcher-kva.example' !== $ascii) {
		fwrite(STDERR, 'Unicode mailbox normalization failed: ' . \var_export($ascii, true) . "\n");
		exit(1);
	}
	$utf8 = \SnappyMail\IDN::emailToUtf8($ascii);
	if ('security@bücher.example' !== $utf8) {
		fwrite(STDERR, 'Unicode mailbox restoration failed: ' . \var_export($utf8, true) . "\n");
		exit(1);
	}
}

$libraries = $sourceRoot . '/v/0.0.0/app/libraries/';
\spl_autoload_register(static function(string $className) use ($libraries): void {
	$file = $libraries . \strtr($className, '\\', DIRECTORY_SEPARATOR) . '.php';
	if (\is_file($file)) {
		require_once $file;
	}
});
final class SnappyMailIdnTestApi
{
	public static function Config(): object
	{
		static $config = null;
		return $config ??= new class {
			public function Get(string $section, string $name, mixed $default = null): mixed
			{
				return $default;
			}
		};
	}
}
\class_alias(SnappyMailIdnTestApi::class, 'RainLoop\\Api');
$domainRoot = \sys_get_temp_dir() . '/snappymail-idn-domain-' . \bin2hex(\random_bytes(8));
if (!\mkdir($domainRoot, 0700)) {
	fwrite(STDERR, "Could not create the domain fixture\n");
	exit(1);
}
try {
	$domainConfig = [
		'IMAP' => ['host' => 'imap.example.test', 'port' => 993, 'type' => 1],
		'SMTP' => ['host' => 'smtp.example.test', 'port' => 465, 'type' => 1],
		'Sieve' => ['enabled' => false, 'host' => '', 'port' => 4190, 'type' => 0],
		'whiteList' => ''
	];
	$domainJson = \json_encode($domainConfig, JSON_THROW_ON_ERROR);
	\file_put_contents($domainRoot . '/boompay.ca.json', $domainJson);
	\file_put_contents($domainRoot . '/default.json', $domainJson);
	\file_put_contents($domainRoot . '/_wildcard_.example.test.json', $domainJson);
	$provider = new \RainLoop\Providers\Domain\DefaultDomain($domainRoot);
	$domain = $provider->Load('BOOMPAY.CA');
	if (!$domain || 'boompay.ca' !== $domain->Name()) {
		fwrite(STDERR, "An ASCII domain configuration must load without ICU\n");
		exit(1);
	}
	$defaultDomain = $provider->Load('*');
	if (!$defaultDomain || '*' !== $defaultDomain->Name()) {
		fwrite(STDERR, "The global wildcard configuration must load without ICU\n");
		exit(1);
	}
	$wildcardDomain = $provider->Load('mail.example.test', true);
	if (!$wildcardDomain || '*.example.test' !== $wildcardDomain->Name()) {
		fwrite(STDERR, "An ASCII subdomain wildcard configuration must load without ICU\n");
		exit(1);
	}
} finally {
	@\unlink($domainRoot . '/boompay.ca.json');
	@\unlink($domainRoot . '/default.json');
	@\unlink($domainRoot . '/_wildcard_.example.test.json');
	@\rmdir($domainRoot);
}

echo "IDN login normalization tests passed\n";
