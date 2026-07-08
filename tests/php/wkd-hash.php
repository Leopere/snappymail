<?php

define('APP_PRIVATE_DATA', \sys_get_temp_dir() . '/snappymail-wkd-test/');

require __DIR__ . '/../../snappymail/v/0.0.0/app/libraries/snappymail/pgp/wkd.php';

$cases = [
	'joe' => 'n4w4kuq9ejc3kmthngg8ccja7y5j8i97',
	'Joe' => 'n4w4kuq9ejc3kmthngg8ccja7y5j8i97',
];

foreach ($cases as $local => $expected) {
	$actual = \SnappyMail\PGP\Wkd::hash($local);
	if ($actual !== $expected) {
		fwrite(STDERR, "WKD hash mismatch for {$local}: {$actual} !== {$expected}\n");
		exit(1);
	}
}

if (32 !== \strlen(\SnappyMail\PGP\Wkd::hash('joe'))) {
	fwrite(STDERR, "WKD hash length mismatch\n");
	exit(1);
}

echo "WKD hash tests passed\n";
