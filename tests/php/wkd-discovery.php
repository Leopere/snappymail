<?php

declare(strict_types=1);

namespace RainLoop {
	final class WkdTestLogger
	{
		public function IsEnabled() : bool
		{
			return false;
		}
	}

	abstract class Api
	{
		public static function Logger() : WkdTestLogger
		{
			return new WkdTestLogger();
		}
	}
}

namespace {
	$sourceRoot = \getenv('SNAPPYMAIL_SOURCE_ROOT') ?: \dirname(__DIR__, 2) . '/snappymail';
	if (!\defined('APP_VERSION')) {
		\define('APP_VERSION', 'test');
	}
	if (!\defined('APP_PRIVATE_DATA')) {
		\define('APP_PRIVATE_DATA', \sys_get_temp_dir() . '/snappymail-wkd-test/');
	}

	require $sourceRoot . '/v/0.0.0/app/libraries/snappymail/log.php';
	require $sourceRoot . '/v/0.0.0/app/libraries/snappymail/http/response.php';
	require $sourceRoot . '/v/0.0.0/app/libraries/snappymail/http/request.php';
	require $sourceRoot . '/v/0.0.0/app/libraries/snappymail/pgp/wkd.php';
	require $sourceRoot . '/v/0.0.0/app/libraries/snappymail/pgp/keyservers.php';
	require $sourceRoot . '/v/0.0.0/app/libraries/RainLoop/ServiceActions.php';

	final class WkdFakeRequest extends \SnappyMail\HTTP\Request
	{
		public array $requests = [];
		private array $results;

		public function __construct(array $results)
		{
			parent::__construct();
			$this->results = $results;
		}

		public function supportsSSL() : bool
		{
			return true;
		}

		protected function __doRequest(string &$method, string &$requestUrl, &$body, array $headers) : \SnappyMail\HTTP\Response
		{
			$this->requests[] = [
				'url' => $requestUrl,
				'timeout' => $this->timeout,
				'force_ipv4' => $this->force_ipv4,
				'verify_peer' => $this->verify_peer,
				'max_redirects' => $this->max_redirects,
				'max_response_kb' => $this->max_response_kb
			];
			$result = \array_shift($this->results) ?? ['status' => 404, 'body' => ''];
			if ($result instanceof \Throwable) {
				throw $result;
			}
			return new \SnappyMail\HTTP\Response(
				$requestUrl,
				$result['status'] ?? 200,
				[],
				$result['body'] ?? ''
			);
		}
	}

	$setRequest = static function (WkdFakeRequest $request) : void {
		$request->max_response_kb = 2048;
		$request->max_redirects = 0;
		$request->verify_peer = true;
		$property = new \ReflectionProperty(\SnappyMail\PGP\Keyservers::class, 'HTTP');
		$property->setAccessible(true);
		$property->setValue(null, $request);
	};
	$assert = static function (bool $condition, string $message) : void {
		if (!$condition) {
			throw new \RuntimeException($message);
		}
	};
	$packet = static function (int $tag, string $body) : string {
		if (192 <= \strlen($body)) {
			throw new \RuntimeException('The WKD packet fixture must remain short.');
		}
		return \chr(0xc0 | $tag) . \chr(\strlen($body)) . $body;
	};
	$publicPacket = $packet(6, "\x04" . \str_repeat("\0", 10));
	$securityKey = $publicPacket . $packet(13, 'Security <security@binding.example.test>');
	$colinKey = $publicPacket . $packet(13, 'Colin <colin@binding.example.test>');
	$assert(\SnappyMail\PGP\Wkd::publicKeyMatchesEmail('security@binding.example.test', $securityKey),
		'A WKD public key must expose the exact requested mailbox in a User ID packet.');
	$assert(!\SnappyMail\PGP\Wkd::publicKeyMatchesEmail('security@binding.example.test', $colinKey),
		'A different mailbox User ID must not be accepted at the requested WKD object.');
	$assert([] === \SnappyMail\PGP\Wkd::publicKeyEmails($packet(5, 'secret') . $packet(13, 'security@binding.example.test')),
		'A secret-key packet must never be accepted as a WKD public key.');
	$bindingHash = \SnappyMail\PGP\Wkd::hash('security');
	$bindingPath = \SnappyMail\PGP\Wkd::publicKeyPath('binding.example.test', $bindingHash);
	@\mkdir(\dirname($bindingPath), 0700, true);
	\file_put_contents($bindingPath, $colinKey);
	$assert('' === \SnappyMail\PGP\Wkd::read('binding.example.test', $bindingHash, ''),
		'A mismatched public key must not be served even when the WKD request omits the local-part query.');
	\file_put_contents($bindingPath, $securityKey);
	$assert($securityKey === \SnappyMail\PGP\Wkd::read('binding.example.test', $bindingHash, 'security'),
		'A correctly bound WKD public key must remain readable.');
	$invokePrivate = static function (string $method, array $arguments) {
		$reflection = new \ReflectionMethod(\SnappyMail\PGP\Keyservers::class, $method);
		$reflection->setAccessible(true);
		return $reflection->invokeArgs(null, $arguments);
	};

	$email = 'retry@example.test';
	$advancedPrefix = 'https://openpgpkey.example.test/.well-known/openpgpkey/example.test/hu/';
	$directPrefix = 'https://example.test/.well-known/openpgpkey/hu/';
	$identityParts = \SnappyMail\PGP\Wkd::emailParts('alice@openpgpkey.example.test');
	$assert('openpgpkey.example.test' === ($identityParts[1] ?? ''),
		'An identity domain beginning with openpgpkey. must not be rewritten to its parent domain.');
	$assert(null === \SnappyMail\PGP\Wkd::emailParts('alice@example.test:443'),
		'An email identity domain must reject a URL-style port instead of silently rewriting it.');
	$service = (new \ReflectionClass(\RainLoop\ServiceActions::class))->newInstanceWithoutConstructor();
	$hostMatches = new \ReflectionMethod(\RainLoop\ServiceActions::class, 'wellKnownHostMatchesWkd');
	$hostMatches->setAccessible(true);
	$assert($hostMatches->invoke($service, 'example.test', 'example.test', false),
		'The direct WKD route must use the exact identity-domain host.');
	$assert($hostMatches->invoke($service, 'openpgpkey.example.test', 'example.test', true),
		'The advanced WKD route must use the exact openpgpkey identity-domain host.');
	$assert(!$hostMatches->invoke($service, 'box.p.example.test', 'example.test', true),
		'An infrastructure subdomain must not become an actual advanced WKD key origin.');

	$retryRequest = new WkdFakeRequest([
		new \RuntimeException('temporary advanced WKD network failure'),
		['status' => 200, 'body' => 'fresh-advanced-key']
	]);
	$setRequest($retryRequest);
	$assert('fresh-advanced-key' === \SnappyMail\PGP\Keyservers::wkd($email, 2000),
		'Advanced WKD must retry one transient network miss and return the fresh public key.');
	$assert(2 === \count($retryRequest->requests), 'Advanced WKD retry must make exactly two attempts.');
	foreach ($retryRequest->requests as $request) {
		$assert(\str_starts_with($request['url'], $advancedPrefix), 'The retry must stay on the standard advanced WKD endpoint.');
		$assert(1 === $request['timeout'], 'Each advanced WKD attempt must be capped at one second.');
		$assert(true === $request['force_ipv4'], 'WKD fetches must prefer IPv4 for predictable public routing.');
		$assert(true === $request['verify_peer'], 'WKD HTTPS fetches must verify the remote TLS certificate.');
		$assert(0 === $request['max_redirects'], 'WKD fetches must not follow redirects to another origin or path.');
		$assert(2048 === $request['max_response_kb'], 'WKD and keyserver responses must have a bounded size.');
	}

	$directRequest = new WkdFakeRequest([
		['status' => 404, 'body' => ''],
		['status' => 200, 'body' => 'fresh-direct-key']
	]);
	$setRequest($directRequest);
	$assert('fresh-direct-key' === \SnappyMail\PGP\Keyservers::wkd($email, 2000),
		'An advanced WKD 404 must fall through to the direct domain WKD endpoint.');
	$assert(2 === \count($directRequest->requests), 'A definitive advanced 404 must not be retried.');
	$assert(\str_starts_with($directRequest->requests[0]['url'], $advancedPrefix),
		'Advanced WKD must be tried before the direct endpoint.');
	$assert(\str_starts_with($directRequest->requests[1]['url'], $directPrefix),
		'The direct WKD endpoint must remain available as a standards fallback.');

	$refreshRequest = new WkdFakeRequest([
		['status' => 200, 'body' => 'fresh-replacement-key']
	]);
	$setRequest($refreshRequest);
	$assert('fresh-replacement-key' === \SnappyMail\PGP\Keyservers::wkd($email, 2000),
		'Every send-time WKD lookup must return the newly fetched public key, not a server-side cached result.');
	$assert(1 === \count($refreshRequest->requests), 'A fresh advanced WKD result must be fetched for each lookup.');

	$customManifest = 'https://box.p.example.test/services/openpgp/recipient-manifest.json';
	$txt = "v=OPENPGPKEY1; alg=sha256-email-v1; url={$customManifest}";
	$assert($customManifest === $invokePrivate('wkdManifestTxtRecordUrl', [$txt, 'example.test']),
		'The fixed identity-domain TXT record must be able to point at a nonstandard manifest path.');
	$assert('' === $invokePrivate('wkdManifestTxtRecordUrl', [
		'v=OPENPGPKEY1; alg=sha256-email-v1; url=https://attacker.test/manifest.json',
		'example.test'
	]), 'A TXT locator must not delegate its manifest outside the identity domain.');
	$assert('' === $invokePrivate('wkdManifestTxtRecordUrl', [
		'v=OPENPGPKEY1; alg=sha256-email-v1; url=https://box.p.example.test/manifest.json?mailbox=retry',
		'example.test'
	]), 'A TXT locator must not smuggle mailbox data in a manifest query string.');
	$assert('' === $invokePrivate('wkdManifestTxtRecordUrl', [
		"v=OPENPGPKEY1; alg=sha256-email-v1; url={$customManifest}; url=https://keys.example.test/other.json",
		'example.test'
	]), 'A TXT locator with duplicate fields must fail closed as ambiguous.');
	$assert(false === $invokePrivate('wkdKeyUrlMatches', [
		$customManifest,
		'example.test',
		\SnappyMail\PGP\Wkd::hash('retry')
	]), 'A nonstandard manifest path must not relax the standard WKD key-object path.');

	$wkdHash = \SnappyMail\PGP\Wkd::hash('retry');
	$directKey = "https://example.test/.well-known/openpgpkey/hu/{$wkdHash}";
	$advancedKey = "https://openpgpkey.example.test/.well-known/openpgpkey/example.test/hu/{$wkdHash}";
	$assert($invokePrivate('wkdKeyUrlMatches', [$directKey, 'example.test', $wkdHash]),
		'A manifest may point to the exact standard direct WKD key URL.');
	$assert($invokePrivate('wkdKeyUrlMatches', [$advancedKey, 'example.test', $wkdHash]),
		'A manifest may point to the exact standard advanced WKD key URL.');
	$assert(false === $invokePrivate('wkdKeyUrlMatches', [
		"https://box.p.example.test/.well-known/openpgpkey/example.test/hu/{$wkdHash}",
		'example.test',
		$wkdHash
	]), 'A manifest must not move an advanced WKD key onto an arbitrary subdomain.');
	$assert(false === $invokePrivate('wkdKeyUrlMatches', [
		"https://openpgpkey.example.test/.well-known/openpgpkey/hu/{$wkdHash}",
		'example.test',
		$wkdHash
	]), 'A manifest must not pair the advanced hostname with the direct WKD path.');

	$record = ['txt' => $txt];
	$assert([$customManifest] === $invokePrivate('wkdManifestTxtRecordUrls', [[$record, $record], 'example.test']),
		'Duplicate copies of the same TXT locator remain one unambiguous URL.');
	$assert([] === $invokePrivate('wkdManifestTxtRecordUrls', [[
		$record,
		['txt' => 'v=OPENPGPKEY1; alg=sha256-email-v1; url=https://keys.example.test/other.json']
	], 'example.test']), 'Conflicting valid TXT locators must fail closed as ambiguous.');

	$manifestDomain = 'manifest.example.test';
	$manifestEntry = ['email_hash' => \str_repeat('a', 64), 'wkd_hash' => $wkdHash];
	$manifestPath = \SnappyMail\PGP\Wkd::manifestPath($manifestDomain);
	@\mkdir(\dirname($manifestPath), 0700, true);
	$assert(false !== \file_put_contents($manifestPath, \json_encode(['entries' => [$manifestEntry]])),
		'The manifest fixture must be writable.');
	$nonstandardBase = "https://box.p.{$manifestDomain}/.well-known/openpgpkey/{$manifestDomain}";
	$generated = \SnappyMail\PGP\Wkd::manifest($manifestDomain, $nonstandardBase);
	$assert(!isset($generated['entries'][0]['key_url']),
		'The manifest generator must not emit an actual key URL on a nonstandard host.');
	$advancedBase = "https://openpgpkey.{$manifestDomain}/.well-known/openpgpkey/{$manifestDomain}";
	$generated = \SnappyMail\PGP\Wkd::manifest($manifestDomain, $advancedBase);
	$assert("{$advancedBase}/hu/{$wkdHash}" === ($generated['entries'][0]['key_url'] ?? ''),
		'The manifest generator must emit the exact standard advanced key URL.');

	echo "WKD discovery tests passed\n";
}
