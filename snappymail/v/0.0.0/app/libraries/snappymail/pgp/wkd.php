<?php

namespace SnappyMail\PGP;

abstract class Wkd
{
	private const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

	public static function normalizeLocal(string $local) : string
	{
		return \strtolower(\trim($local));
	}

	public static function normalizeDomain(string $domain) : string
	{
		$domain = \strtolower(\trim($domain, " \t\n\r\0\x0B."));
		$domain = \preg_replace('/:\d+$/', '', $domain);
		if (\str_starts_with($domain, 'openpgpkey.')) {
			$domain = \substr($domain, 11);
		}
		return \preg_match('/^[a-z0-9.-]+$/', $domain) ? $domain : '';
	}

	public static function emailParts(string $email) : ?array
	{
		$email = \trim($email);
		if (!\preg_match('/^([^@\s<>]+)@([^@\s<>]+)$/', $email, $matches)) {
			return null;
		}
		$local = static::normalizeLocal($matches[1]);
		$domain = static::normalizeDomain($matches[2]);
		return ($local && $domain) ? [$local, $domain] : null;
	}

	public static function hash(string $local) : string
	{
		$bytes = \hash('sha1', static::normalizeLocal($local), true);
		$bits = '';
		for ($i = 0, $len = \strlen($bytes); $i < $len; ++$i) {
			$bits .= \str_pad(\decbin(\ord($bytes[$i])), 8, '0', STR_PAD_LEFT);
		}

		$result = '';
		for ($i = 0, $len = \strlen($bits); $i < $len; $i += 5) {
			$chunk = \substr($bits, $i, 5);
			if (5 > \strlen($chunk)) {
				$chunk = \str_pad($chunk, 5, '0', STR_PAD_RIGHT);
			}
			$result .= self::ZBASE32[\bindec($chunk)];
		}
		return $result;
	}

	public static function publicKeyPath(string $domain, string $hash) : string
	{
		$domain = static::normalizeDomain($domain);
		$hash = \strtolower(\trim($hash));
		if (!$domain || !\preg_match('/^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/', $hash)) {
			return '';
		}
		return APP_PRIVATE_DATA . 'openpgpkey/' . $domain . '/hu/' . $hash;
	}

	public static function armoredPublicKeyToBinary(string $key) : string
	{
		if (!\preg_match('/-----BEGIN PGP PUBLIC KEY BLOCK-----(.*?)-----END PGP PUBLIC KEY BLOCK-----/s', $key, $match)) {
			return $key;
		}

		$body = \preg_replace('/\R[^\r\n:]+:.*(?=\R\R)/', '', $match[1]);
		$body = \preg_replace('/\R=.+$/s', '', $body);
		$body = \preg_replace('/[^A-Za-z0-9+\/=]/', '', $body);
		$binary = \base64_decode($body, true);
		return false === $binary ? '' : $binary;
	}

	public static function publish(string $email, string $publicKey) : bool
	{
		$parts = static::emailParts($email);
		if (!$parts) {
			return false;
		}

		[$local, $domain] = $parts;
		$path = static::publicKeyPath($domain, static::hash($local));
		$binary = static::armoredPublicKeyToBinary($publicKey);
		if (!$path || !$binary) {
			return false;
		}

		\MailSo\Base\Utils::mkdir(\dirname($path));
		return false !== \file_put_contents($path, $binary, LOCK_EX);
	}

	public static function read(string $domain, string $hash, string $local = '') : string
	{
		$domain = static::normalizeDomain($domain);
		$hash = \strtolower(\trim($hash));
		if ($local && !\hash_equals(static::hash($local), $hash)) {
			return '';
		}

		$path = static::publicKeyPath($domain, $hash);
		return ($path && \is_file($path)) ? (string) \file_get_contents($path) : '';
	}
}
