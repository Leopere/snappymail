<?php

namespace SnappyMail\HTTP;

/**
 * Normalizes the request scheme seen by PHP when TLS terminates at a reverse
 * proxy that forwards plain HTTP to PHP-FPM. MailSo\Base\Http::IsSecure()
 * already trusts the same proxy headers; SnappyMail\Cookies only looks at
 * $_SERVER['HTTPS'] when deciding whether session and connection tokens get
 * the Secure attribute, so both views must agree.
 */
abstract class Scheme
{
	public static function normalize(array &$server) : void
	{
		if (empty($server['HTTPS']) || 'off' === \strtolower((string) $server['HTTPS'])) {
			unset($server['HTTPS']);
		}
		if (isset($server['HTTPS'])) {
			$server['HTTPS'] = 'on';
			return;
		}
		if ('https' === \strtolower((string) ($server['REQUEST_SCHEME'] ?? ''))
		 || 'https' === \strtolower(\trim(\strtok((string) ($server['HTTP_X_FORWARDED_PROTO'] ?? ''), ',')))
		 || 'on' === \strtolower((string) ($server['HTTP_X_FORWARDED_SSL'] ?? ''))) {
			$server['HTTPS'] = 'on';
		}
	}
}
