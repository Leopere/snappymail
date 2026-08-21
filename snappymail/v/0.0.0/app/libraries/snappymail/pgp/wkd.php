<?php

namespace SnappyMail\PGP;

abstract class Wkd
{
	/** Serialize vault state changes with WKD publication and production audits. */
	public static function transaction(callable $callback)
	{
		$path = APP_PRIVATE_DATA . 'openpgpkey/.vault-transaction.lock';
		\MailSo\Base\Utils::mkdir(\dirname($path));
		$lock = \fopen($path, 'c');
		if (!$lock || !\flock($lock, LOCK_EX)) {
			\is_resource($lock) && \fclose($lock);
			throw new \RuntimeException('Could not lock the browser vault/WKD transaction.');
		}
		try {
			return $callback();
		} finally {
			\flock($lock, LOCK_UN);
			\fclose($lock);
		}
	}

	private const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

	public static function normalizeLocal(string $local) : string
	{
		return \strtolower(\trim($local));
	}

	public static function normalizeDomain(string $domain) : string
	{
		if (\preg_match('/:\d+$/', \trim($domain))) {
			return '';
		}
		return static::normalizeHost($domain);
	}

	public static function normalizeHost(string $host) : string
	{
		$domain = \strtolower(\trim($host, " \t\n\r\0\x0B."));
		$domain = \preg_replace('/:\d+$/', '', $domain);
		if (!$domain || 253 < \strlen($domain) || false !== \filter_var($domain, FILTER_VALIDATE_IP)) {
			return '';
		}
		$labels = \explode('.', $domain);
		if (2 > \count($labels)) {
			return '';
		}
		foreach ($labels as $label) {
			if (!$label || 63 < \strlen($label)
				|| !\preg_match('/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/', $label)) {
				return '';
			}
		}
		return $domain;
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

	public static function emailHash(string $email) : string
	{
		$parts = static::emailParts($email);
		if (!$parts) {
			return '';
		}
		return \hash('sha256', $parts[0] . '@' . $parts[1]);
	}

	public static function urlAllowed(string $url, string $domain) : bool
	{
		$parts = \parse_url($url);
		if (!\is_array($parts)
			|| 'https' !== \strtolower((string) ($parts['scheme'] ?? ''))
			|| !empty($parts['user'])
			|| !empty($parts['pass'])
			|| !empty($parts['query'])
			|| !empty($parts['fragment'])
			|| (isset($parts['port']) && 443 !== (int) $parts['port'])) {
			return false;
		}

		$host = static::normalizeHost((string) ($parts['host'] ?? ''));
		$domain = static::normalizeDomain($domain);
		$path = (string) ($parts['path'] ?? '');
		if (!$host || !$domain || !\str_starts_with($path, '/.well-known/openpgpkey/')) {
			return false;
		}

		$advancedPath = '/.well-known/openpgpkey/' . $domain . '/';
		$directPath = '/.well-known/openpgpkey/';
		$directFile = $path === $directPath . 'index.json'
			|| $path === $directPath . 'policy'
			|| \str_starts_with($path, $directPath . 'hu/');
		return ($host === $domain && $directFile)
			|| ($host === 'openpgpkey.' . $domain && \str_starts_with($path, $advancedPath));
	}

	public static function manifestUrlAllowed(string $url, string $domain) : bool
	{
		$parts = \parse_url($url);
		if (!\is_array($parts)
			|| 'https' !== \strtolower((string) ($parts['scheme'] ?? ''))
			|| !empty($parts['user'])
			|| !empty($parts['pass'])
			|| !empty($parts['query'])
			|| !empty($parts['fragment'])
			|| (isset($parts['port']) && 443 !== (int) $parts['port'])) {
			return false;
		}

		$host = static::normalizeHost((string) ($parts['host'] ?? ''));
		$domain = static::normalizeDomain($domain);
		$path = (string) ($parts['path'] ?? '');
		return $host && $domain && \str_starts_with($path, '/')
			&& ($host === $domain
				|| $host === 'openpgpkey.' . $domain
				|| \str_ends_with($host, '.' . $domain));
	}

	public static function keyUrlAllowed(string $url, string $domain, string $wkdHash) : bool
	{
		$domain = static::normalizeDomain($domain);
		$wkdHash = \strtolower(\trim($wkdHash));
		if (!$domain
			|| !\preg_match('/^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/', $wkdHash)
			|| !static::urlAllowed($url, $domain)) {
			return false;
		}

		$parts = \parse_url($url);
		$host = static::normalizeHost((string) ($parts['host'] ?? ''));
		$path = (string) ($parts['path'] ?? '');
		return ($host === $domain && "/.well-known/openpgpkey/hu/{$wkdHash}" === $path)
			|| ($host === 'openpgpkey.' . $domain
				&& "/.well-known/openpgpkey/{$domain}/hu/{$wkdHash}" === $path);
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

	public static function manifestPath(string $domain) : string
	{
		$domain = static::normalizeDomain($domain);
		return $domain ? APP_PRIVATE_DATA . 'openpgpkey/' . $domain . '/index.json' : '';
	}

	public static function manifest(string $domain, string $baseUrl = '') : array
	{
		$domain = static::normalizeDomain($domain);
		$path = $domain ? static::manifestPath($domain) : '';
		$data = ($path && \is_file($path)) ? \json_decode((string) \file_get_contents($path), true) : null;
		$entries = \is_array($data['entries'] ?? null) ? $data['entries'] : [];
		$baseUrl = \rtrim($baseUrl, '/');

		$filtered = [];
		foreach ($entries as $entry) {
			$emailHash = \strtolower((string) ($entry['email_hash'] ?? ''));
			$wkdHash = \strtolower((string) ($entry['wkd_hash'] ?? ''));
			if (!\preg_match('/^[a-f0-9]{64}$/', $emailHash)
				|| !\preg_match('/^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/', $wkdHash)) {
				continue;
			}
			$item = [
				'email_hash' => $emailHash,
				'wkd_hash' => $wkdHash
			];
			if (!empty($entry['key_url']) && \is_string($entry['key_url'])
				&& static::keyUrlAllowed($entry['key_url'], $domain, $wkdHash)) {
				$item['key_url'] = $entry['key_url'];
			} else if ($baseUrl) {
				$keyUrl = $baseUrl . '/hu/' . $wkdHash;
				if (static::keyUrlAllowed($keyUrl, $domain, $wkdHash)) {
					$item['key_url'] = $keyUrl;
				}
			}
			$filtered[] = $item;
		}

		return [
			'version' => 1,
			'algorithm' => 'sha256-email-v1',
			'domain' => $domain,
			'generated_at' => \gmdate('c'),
			'entries' => $filtered
		];
	}

	public static function writeManifest(string $domain, array $entries) : bool
	{
		$domain = static::normalizeDomain($domain);
		$path = $domain ? static::manifestPath($domain) : '';
		if (!$path) {
			return false;
		}

		$unique = [];
		foreach ($entries as $entry) {
			$emailHash = \strtolower((string) ($entry['email_hash'] ?? ''));
			$wkdHash = \strtolower((string) ($entry['wkd_hash'] ?? ''));
			if (\preg_match('/^[a-f0-9]{64}$/', $emailHash)
				&& \preg_match('/^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/', $wkdHash)) {
				$unique[$emailHash] = [
					'email_hash' => $emailHash,
					'wkd_hash' => $wkdHash
				];
			}
		}

		return static::writeFileAtomically($path, \json_encode([
			'version' => 1,
			'algorithm' => 'sha256-email-v1',
			'domain' => $domain,
			'generated_at' => \gmdate('c'),
			'entries' => \array_values($unique)
		], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
	}

	private static function writeFileAtomically(string $path, string $data) : bool
	{
		$directory = \dirname($path);
		\MailSo\Base\Utils::mkdir($directory);
		$temporary = \tempnam($directory, '.wkd-');
		if (false === $temporary) {
			return false;
		}
		$written = false !== \file_put_contents($temporary, $data, LOCK_EX)
			&& \chmod($temporary, 0600)
			&& @\rename($temporary, $path);
		\is_file($temporary) && \unlink($temporary);
		return $written;
	}

	private static function manifestHasEntry(string $email, string $domain, string $wkdHash) : bool
	{
		$emailHash = static::emailHash($email);
		foreach (static::manifest($domain)['entries'] as $entry) {
			if ($emailHash === $entry['email_hash'] && $wkdHash === $entry['wkd_hash']) {
				return true;
			}
		}
		return false;
	}

	private static function publishManifestEntry(string $email, string $domain, string $wkdHash) : bool
	{
		$manifest = static::manifest($domain);
		$manifest['entries'][] = [
			'email_hash' => static::emailHash($email),
			'wkd_hash' => $wkdHash
		];
		return static::writeManifest($domain, $manifest['entries']);
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

	private static function packetLength(string $binary, int &$offset, int $lengthType, bool $newFormat) : int
	{
		$size = \strlen($binary);
		if ($newFormat) {
			if ($offset >= $size) {
				return -1;
			}
			$first = \ord($binary[$offset++]);
			if (192 > $first) {
				return $first;
			}
			if (224 > $first) {
				return $offset < $size ? (($first - 192) << 8) + \ord($binary[$offset++]) + 192 : -1;
			}
			if (255 === $first) {
				if ($offset + 4 > $size) {
					return -1;
				}
				$length = \unpack('Nlength', \substr($binary, $offset, 4));
				$offset += 4;
				return (int) ($length['length'] ?? -1);
			}
			// Partial-body packets are unnecessary for the small public keys accepted here.
			return -1;
		}

		$bytes = [1, 2, 4][$lengthType] ?? 0;
		if (!$bytes || $offset + $bytes > $size) {
			return -1;
		}
		$length = 0;
		for ($index = 0; $index < $bytes; ++$index) {
			$length = ($length << 8) | \ord($binary[$offset++]);
		}
		return $length;
	}

	public static function publicKeyEmails(string $publicKey) : array
	{
		$binary = static::armoredPublicKeyToBinary($publicKey);
		$size = \strlen($binary);
		$offset = 0;
		$emails = [];
		$publicKeyPacket = false;
		while ($offset < $size) {
			$header = \ord($binary[$offset++]);
			if (0x80 !== ($header & 0x80)) {
				return [];
			}
			$newFormat = 0 !== ($header & 0x40);
			$tag = $newFormat ? ($header & 0x3f) : (($header >> 2) & 0x0f);
			$lengthType = $newFormat ? 0 : ($header & 0x03);
			if (!$newFormat && 3 === $lengthType) {
				return [];
			}
			$length = static::packetLength($binary, $offset, $lengthType, $newFormat);
			if (0 > $length || $offset + $length > $size) {
				return [];
			}
			$body = \substr($binary, $offset, $length);
			$offset += $length;
			if (5 === $tag || 7 === $tag) {
				return [];
			}
			$publicKeyPacket = $publicKeyPacket || 6 === $tag;
			if (13 === $tag && \preg_match_all('/[^\s<>]+@[^\s<>]+/', $body, $matches)) {
				foreach ($matches[0] as $email) {
					$parts = static::emailParts($email);
					$parts && $emails[] = $parts[0] . '@' . $parts[1];
				}
			}
		}
		return $publicKeyPacket ? \array_values(\array_unique($emails)) : [];
	}

	public static function publicKeyMatchesEmail(string $email, string $publicKey) : bool
	{
		$parts = static::emailParts($email);
		$email = $parts ? $parts[0] . '@' . $parts[1] : '';
		return $email && [$email] === static::publicKeyEmails($publicKey);
	}

	private static function removeInspectionDirectory(string $path) : void
	{
		if (!\is_dir($path) || \is_link($path)) {
			return;
		}
		foreach (\array_diff(\scandir($path) ?: [], ['.', '..']) as $entry) {
			$child = $path . '/' . $entry;
			\is_dir($child) && !\is_link($child)
				? static::removeInspectionDirectory($child)
				: @\unlink($child);
		}
		@\rmdir($path);
	}

	/** Validate one mailbox-bound certificate with usable signing and encryption keys. */
	public static function publicKeyUsableForEmail(string $email, string $publicKey) : bool
	{
		if (!static::publicKeyMatchesEmail($email, $publicKey)
			|| !\is_callable('proc_open') || !\is_executable('/usr/bin/gpg')) {
			return false;
		}
		$home = \sys_get_temp_dir() . '/snappymail-wkd-inspect-' . \bin2hex(\random_bytes(8));
		if (!\mkdir($home, 0700)) {
			return false;
		}
		try {
			$process = \proc_open([
				'/usr/bin/gpg', '--batch', '--no-options', '--homedir', $home,
				'--with-colons', '--import-options', 'show-only', '--dry-run', '--import'
			], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
			if (!\is_resource($process)) {
				return false;
			}
			\fwrite($pipes[0], $publicKey);
			\fclose($pipes[0]);
			$output = (string) \stream_get_contents($pipes[1]);
			\stream_get_contents($pipes[2]);
			\fclose($pipes[1]);
			\fclose($pipes[2]);
			if (0 !== \proc_close($process)) {
				return false;
			}
		} finally {
			static::removeInspectionDirectory($home);
		}

		$certificates = 0;
		$uids = 0;
		$canEncrypt = false;
		$canSign = false;
		foreach (\explode("\n", $output) as $line) {
			$fields = \explode(':', $line);
			$type = $fields[0] ?? '';
			if ('sec' === $type || 'ssb' === $type) {
				return false;
			}
			if ('pub' === $type) {
				++$certificates;
				if (\in_array($fields[1] ?? '', ['r', 'e', 'd', 'i'], true)) {
					return false;
				}
			}
			'uid' === $type && ++$uids;
			if ('pub' === $type || 'sub' === $type) {
				$capabilities = \strtolower($fields[11] ?? '');
				$canEncrypt = $canEncrypt || \str_contains($capabilities, 'e');
				$canSign = $canSign || \str_contains($capabilities, 's');
			}
		}
		return 1 === $certificates && 1 === $uids && $canEncrypt && $canSign;
	}

	private static function publicKeyMatchesObject(string $domain, string $hash, string $publicKey) : bool
	{
		$emails = static::publicKeyEmails($publicKey);
		$parts = 1 === \count($emails) ? static::emailParts($emails[0]) : null;
		return $parts && $parts[1] === $domain && static::hash($parts[0]) === $hash;
	}

	public static function matches(string $email, string $publicKey) : bool
	{
		$parts = static::emailParts($email);
		if (!$parts || !static::publicKeyMatchesEmail($email, $publicKey)) {
			return false;
		}

		[$local, $domain] = $parts;
		$binary = static::armoredPublicKeyToBinary($publicKey);
		$current = $binary ? static::read($domain, static::hash($local), $local) : '';
		return $current && \hash_equals($current, $binary)
			&& static::manifestHasEntry($email, $domain, static::hash($local));
	}

	public static function publish(string $email, string $publicKey) : bool
	{
		$parts = static::emailParts($email);
		if (!$parts || !static::publicKeyMatchesEmail($email, $publicKey)) {
			return false;
		}

		[$local, $domain] = $parts;
		$hash = static::hash($local);
		$path = static::publicKeyPath($domain, $hash);
		$binary = static::armoredPublicKeyToBinary($publicKey);
		if (!$path || !$binary) {
			return false;
		}

		$lockPath = \dirname(static::manifestPath($domain)) . '/.publish.lock';
		\MailSo\Base\Utils::mkdir(\dirname($lockPath));
		$lock = \fopen($lockPath, 'c');
		if (!$lock || !\flock($lock, LOCK_EX)) {
			\is_resource($lock) && \fclose($lock);
			return false;
		}
		try {
			$previous = \is_file($path) ? (string) \file_get_contents($path) : null;
			if (!static::writeFileAtomically($path, $binary)) {
				return false;
			}
			if (static::publishManifestEntry($email, $domain, $hash)) {
				return true;
			}
			$rolledBack = null === $previous
				? (!\is_file($path) || \unlink($path))
				: static::writeFileAtomically($path, $previous);
			if (!$rolledBack) {
				throw new \RuntimeException('WKD publication and key rollback both failed.');
			}
			return false;
		} finally {
			\flock($lock, LOCK_UN);
			\fclose($lock);
		}
	}

	/**
	 * Withdraw one mailbox key without exposing or disturbing any other entry.
	 * A failed manifest update restores the previous key object.
	 */
	public static function unpublish(string $email) : bool
	{
		$parts = static::emailParts($email);
		if (!$parts) {
			return false;
		}

		[$local, $domain] = $parts;
		$hash = static::hash($local);
		$path = static::publicKeyPath($domain, $hash);
		$emailHash = static::emailHash($email);
		$lockPath = \dirname(static::manifestPath($domain)) . '/.publish.lock';
		\MailSo\Base\Utils::mkdir(\dirname($lockPath));
		$lock = \fopen($lockPath, 'c');
		if (!$path || !$lock || !\flock($lock, LOCK_EX)) {
			\is_resource($lock) && \fclose($lock);
			return false;
		}
		try {
			$manifest = static::manifest($domain);
			$entries = \array_values(\array_filter(
				$manifest['entries'],
				static fn(array $entry) : bool => $emailHash !== ($entry['email_hash'] ?? '')
			));
			$listed = \count($entries) !== \count($manifest['entries']);
			$previous = \is_file($path) ? (string) \file_get_contents($path) : null;
			if (null === $previous && !$listed) {
				return true;
			}
			if (null !== $previous && !\unlink($path)) {
				return false;
			}
			if (static::writeManifest($domain, $entries)) {
				return true;
			}
			$rolledBack = null === $previous || static::writeFileAtomically($path, $previous);
			if (!$rolledBack) {
				throw new \RuntimeException('WKD withdrawal and key rollback both failed.');
			}
			return false;
		} finally {
			\flock($lock, LOCK_UN);
			\fclose($lock);
		}
	}

	public static function read(string $domain, string $hash, string $local = '') : string
	{
		$domain = static::normalizeDomain($domain);
		$hash = \strtolower(\trim($hash));
		if ($local && !\hash_equals(static::hash($local), $hash)) {
			return '';
		}

		$path = static::publicKeyPath($domain, $hash);
		$key = ($path && \is_file($path)) ? (string) \file_get_contents($path) : '';
		if (!static::publicKeyMatchesObject($domain, $hash, $key)) {
			return '';
		}
		return (!$local || static::publicKeyMatchesEmail("{$local}@{$domain}", $key)) ? $key : '';
	}
}
