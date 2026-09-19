<?php

$sourceRoot = \getenv('SNAPPYMAIL_SOURCE_ROOT') ?: \realpath(__DIR__ . '/../../snappymail');
require $sourceRoot . '/v/0.0.0/app/libraries/snappymail/http/scheme.php';

function check(bool $result, string $message): void
{
	if (!$result) {
		throw new RuntimeException($message);
	}
}

function normalized(array $server): array
{
	\SnappyMail\HTTP\Scheme::normalize($server);
	return $server;
}

check(!isset(normalized([])['HTTPS']), 'Plain HTTP without proxy headers must stay insecure');
check(!isset(normalized(['HTTPS' => 'off'])['HTTPS']), 'HTTPS=off must be removed');
check(!isset(normalized(['HTTPS' => ''])['HTTPS']), 'Empty HTTPS must be removed');
check('on' === normalized(['HTTPS' => 'on'])['HTTPS'], 'HTTPS=on must be kept');
check('on' === normalized(['HTTPS' => '1'])['HTTPS'], 'Truthy HTTPS values must normalize to on');
check('on' === normalized(['REQUEST_SCHEME' => 'https'])['HTTPS'], 'REQUEST_SCHEME=https must set HTTPS');
check(!isset(normalized(['REQUEST_SCHEME' => 'http'])['HTTPS']), 'REQUEST_SCHEME=http must stay insecure');
check('on' === normalized(['HTTP_X_FORWARDED_PROTO' => 'https'])['HTTPS'],
	'X-Forwarded-Proto: https from the TLS-terminating proxy must set HTTPS');
check('on' === normalized(['HTTP_X_FORWARDED_PROTO' => 'HTTPS'])['HTTPS'], 'Header values are case-insensitive');
check('on' === normalized(['HTTP_X_FORWARDED_PROTO' => 'https, http'])['HTTPS'],
	'The first hop of a chained X-Forwarded-Proto decides');
check(!isset(normalized(['HTTP_X_FORWARDED_PROTO' => 'http, https'])['HTTPS']),
	'A later https hop must not upgrade a plain first hop');
check(!isset(normalized(['HTTP_X_FORWARDED_PROTO' => 'http'])['HTTPS']), 'X-Forwarded-Proto: http must stay insecure');
check('on' === normalized(['HTTP_X_FORWARDED_SSL' => 'on'])['HTTPS'], 'X-Forwarded-Ssl: on must set HTTPS');
check(!isset(normalized(['HTTP_X_FORWARDED_SSL' => 'off'])['HTTPS']), 'X-Forwarded-Ssl: off must stay insecure');
check(!isset(normalized(['HTTPS' => 'off', 'REQUEST_SCHEME' => 'http', 'HTTP_X_FORWARDED_PROTO' => 'http'])['HTTPS']),
	'Consistent plain HTTP must stay insecure');
check('on' === normalized(['HTTPS' => 'off', 'HTTP_X_FORWARDED_PROTO' => 'https'])['HTTPS'],
	'A proxy TLS hop must win over the FastCGI default of HTTPS=off');

// Both server-side views of "is this request secure" must agree.
$include = \file_get_contents($sourceRoot . '/v/0.0.0/include.php');
check(false !== \strpos($include, 'SnappyMail\HTTP\Scheme::normalize($_SERVER);'),
	'include.php must normalize the scheme through SnappyMail\HTTP\Scheme');
check(\strpos($include, 'Scheme::normalize($_SERVER)') < \strpos($include, "header('Strict-Transport-Security"),
	'Scheme normalization must precede the HSTS header decision');
$cookies = \file_get_contents($sourceRoot . '/v/0.0.0/app/libraries/snappymail/cookies.php');
check(false !== \strpos($cookies, "static::\$Secure = isset(\$_SERVER['HTTPS'])"),
	'SnappyMail\Cookies must keep deriving the Secure attribute from HTTPS');
$http = \file_get_contents($sourceRoot . '/v/0.0.0/app/libraries/MailSo/Base/Http.php');
check(false !== \strpos($http, "static::GetServer('HTTP_X_FORWARDED_PROTO', '')")
	&& false !== \strpos($http, "static::GetServer('HTTP_X_FORWARDED_SSL', '')"),
	'MailSo\Base\Http::IsSecure must trust the same proxy headers as Scheme::normalize');

echo "Proxy HTTPS scheme normalization passed\n";
