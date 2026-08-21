<?php

declare(strict_types=1);

if (!\defined('APP_VERSION')) {
	\define('APP_VERSION', 'test');
}

$root = \getenv('SNAPPYMAIL_SOURCE_ROOT') ?: \dirname(__DIR__, 2);
require $root . '/snappymail/v/0.0.0/app/libraries/snappymail/http/response.php';
require $root . '/snappymail/v/0.0.0/app/libraries/snappymail/http/request.php';
require $root . '/plugins/rocksign/RockSignClient.php';

final class RockSignFakeRequest extends \SnappyMail\HTTP\Request
{
	public array $calls = [];

	public function __construct(private $result)
	{
		parent::__construct();
	}

	public function supportsSSL() : bool
	{
		return true;
	}

	protected function __doRequest(string &$method, string &$requestUrl, &$body, array $headers) : \SnappyMail\HTTP\Response
	{
		$this->calls[] = [
			'method' => $method,
			'url' => $requestUrl,
			'body' => $body,
			'headers' => $headers,
			'timeout' => $this->timeout,
			'max_redirects' => $this->max_redirects,
			'verify_peer' => $this->verify_peer,
			'max_response_kb' => $this->max_response_kb
		];
		if ($this->result instanceof \Throwable) {
			throw $this->result;
		}
		$result = $this->result;
		$body = (string) ($result['body'] ?? '');
		$headers = (array) ($result['headers'] ?? [
			'Content-Type: application/json',
			'Content-Length: ' . \strlen($body)
		]);
		return new \SnappyMail\HTTP\Response($requestUrl, (int) ($result['status'] ?? 200), $headers, $body);
	}
}

$assert = static function (bool $condition, string $message) : void {
	if (!$condition) {
		throw new \RuntimeException($message);
	}
};

$queue = [
	['body' => '{"id":7,"email":"integration@boompay.ca","capabilities":{"create_submission":true,"sign_pdf":true}}'],
	['body' => '{"signed_by_instance":true}'],
	[
		'body' => "%PDF-1.7\ncontract",
		'headers' => ['Content-Type: application/pdf', 'Content-Length: 17']
	],
	new \RuntimeException('simulated timeout'),
	['status' => 302, 'body' => ''],
	['status' => 422, 'body' => '{"error":"Template not found"}'],
	['status' => 500, 'body' => '<html>upstream failure</html>'],
	['status' => 200, 'body' => '{malformed'],
	['status' => 200, 'body' => '{"created":true}'],
	['status' => 302, 'body' => ''],
	['status' => 200, 'body' => ''],
	new \RuntimeException('simulated read timeout')
];
$requests = [];
$masked = [];
$factory = static function () use (&$queue, &$requests) : RockSignFakeRequest {
	$request = new RockSignFakeRequest(\array_shift($queue));
	$requests[] = $request;
	return $request;
};
$client = new RockSignClient('server-only-token', $factory, static function (string $secret) use (&$masked) : void {
	$masked[] = $secret;
});

$user = $client->json('GET', '/api/user');
$assert('integration@boompay.ca' === $user['email'], 'GET /api/user must return decoded RockSign JSON.');
$call = $requests[0]->calls[0];
$assert('https://sign.boompay.ca/api/user' === $call['url'], 'Authenticated calls must use the fixed RockSign origin.');
$assert(true === $call['verify_peer'], 'RockSign TLS peer verification must be enabled explicitly.');
$assert(0 === $call['max_redirects'], 'RockSign requests must reject redirects.');
$assert(20 === $call['timeout'], 'RockSign requests must use the fixed bounded timeout.');
$assert(\in_array('X-Auth-Token: server-only-token', $call['headers'], true), 'The API token must be sent server-side.');
$assert(\in_array('Accept-Encoding: identity', $call['headers'], true), 'Compressed responses must be disabled for reliable byte limits.');
$assert(['server-only-token'] === $masked, 'The API token must be registered with the logger secret masker.');

$verified = $client->json('POST', '/api/tools/verify', ['file' => 'pdf']);
$assert(true === $verified['signed_by_instance'], 'Authenticated verification JSON must be decoded.');
$assert((bool) \array_filter(
	$requests[1]->calls[0]['headers'],
	static fn(string $header) => \str_starts_with($header, 'X-Auth-Token:')
), 'The authenticated PDF verifier must receive the API token.');

$pdf = $client->downloadPdf('https://sign.boompay.ca/rails/active_storage/blobs/proxy/signed/contract.pdf', 1024);
$assert(\str_starts_with($pdf, '%PDF-'), 'Completed document downloads must preserve the exact PDF bytes.');
$assert(0 === $requests[2]->max_redirects, 'Completed document downloads must reject redirects.');
$assert(!$client->downloadUrlAllowed('https://attacker.example/contract.pdf'),
	'RockSign document URLs must not escape the fixed origin.');
$assert(!$client->downloadUrlAllowed('https://sign.boompay.ca:444/contract.pdf'),
	'RockSign document URLs must not select a nonstandard port.');
$assert($client->signingUrlAllowed('https://sign.boompay.ca/s/123456789ABCDE'),
	'Private signing links must accept the exact RockSign submit-form route.');
$assert(!$client->signingUrlAllowed('https://sign.boompay.ca/settings/profile'),
	'An arbitrary same-origin RockSign page must not be accepted as a private signing link.');
$assert(!$client->signingUrlAllowed('https://sign.boompay.ca/s/123456789ABCDE?next=/settings'),
	'Private signing links must not carry an unexpected query string.');

try {
	$client->json('POST', '/api/submissions/init', ['template_id' => 1], true, 1048576, true);
	throw new \RuntimeException('A transport timeout must fail.');
} catch (RockSignApiException $e) {
	$assert($e->statusUnknown(), 'A submission timeout must be reported as status unknown.');
}

try {
	$client->json('GET', '/api/user');
	throw new \RuntimeException('A redirect must fail.');
} catch (RockSignApiException $e) {
	$assert(302 === $e->responseStatus(), 'A redirect response must be rejected without following it.');
}

try {
	$client->json('POST', '/api/submissions/init', ['template_id' => 999], true, 1048576, true);
	throw new \RuntimeException('A validation response must fail.');
} catch (RockSignApiException $e) {
	$assert(422 === $e->responseStatus() && !$e->statusUnknown(),
		'A RockSign validation error must remain distinct from an unknown create status.');
}

try {
	$client->json('POST', '/api/submissions/init', ['template_id' => 1], true, 1048576, true);
	throw new \RuntimeException('A malformed HTTP 500 response must fail.');
} catch (RockSignApiException $e) {
	$assert(500 === $e->responseStatus() && $e->statusUnknown(),
		'A malformed server error after a create request must report status unknown.');
}

try {
	$client->json('POST', '/api/submissions/init', ['template_id' => 1], true, 1048576, true);
	throw new \RuntimeException('A malformed HTTP 200 response must fail.');
} catch (RockSignApiException $e) {
	$assert(200 === $e->responseStatus() && $e->statusUnknown(),
		'A malformed success response after a create request must report status unknown.');
}

try {
	$client->json('POST', '/api/submissions/init', ['template_id' => 1], true, 8, true);
	throw new \RuntimeException('An oversized HTTP 200 response must fail.');
} catch (RockSignApiException $e) {
	$assert(200 === $e->responseStatus() && $e->statusUnknown(),
		'An oversized success response after a create request must report status unknown.');
}

try {
	$client->json('POST', '/api/submissions/init', ['template_id' => 1], true, 1048576, true);
	throw new \RuntimeException('A redirect after a create request must fail.');
} catch (RockSignApiException $e) {
	$assert(302 === $e->responseStatus() && $e->statusUnknown(),
		'An unexpected redirect after a create request must report status unknown.');
}

try {
	$client->json('POST', '/api/submissions/init', ['template_id' => 1], true, 1048576, true);
	throw new \RuntimeException('An empty HTTP 200 response must fail.');
} catch (RockSignApiException $e) {
	$assert(200 === $e->responseStatus() && $e->statusUnknown(),
		'An empty success response after a create request must report status unknown.');
}

try {
	$client->json('GET', '/api/user');
	throw new \RuntimeException('A read timeout must fail.');
} catch (RockSignApiException $e) {
	$assert(!$e->statusUnknown(), 'A failed idempotent read must not be described as an unknown mutation status.');
}

echo "RockSign integration tests passed\n";
