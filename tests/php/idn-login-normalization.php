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

echo "IDN login normalization tests passed\n";
