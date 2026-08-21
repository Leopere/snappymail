<?php

final class RockSignApiException extends \RuntimeException
{
	public function __construct(
		string $message,
		private int $responseStatus = 0,
		private bool $statusUnknown = false,
		?\Throwable $previous = null
	) {
		parent::__construct($message, 0, $previous);
	}

	public function responseStatus() : int
	{
		return $this->responseStatus;
	}

	public function statusUnknown() : bool
	{
		return $this->statusUnknown;
	}
}

final class RockSignClient
{
	public const BASE_URL = 'https://sign.boompay.ca';

	private $requestFactory;
	private $maskSecret;

	public function __construct(
		#[\SensitiveParameter]
		private string $token,
		?callable $requestFactory = null,
		?callable $maskSecret = null
	) {
		$this->requestFactory = $requestFactory ?: static fn() => \SnappyMail\HTTP\Request::factory();
		$this->maskSecret = $maskSecret;
		$this->mask($token);
	}

	public function json(
		string $method,
		string $path,
		?array $data = null,
		bool $authenticated = true,
		int $maxResponseBytes = 1048576,
		bool $mutation = false
	) : array {
		if (!\str_starts_with($path, '/') || \str_starts_with($path, '//')) {
			throw new \LogicException('RockSign API paths must be origin-relative.');
		}

		$body = null;
		$headers = ['Accept: application/json', 'Accept-Encoding: identity'];
		if (null !== $data) {
			$body = \json_encode($data, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
			$headers[] = 'Content-Type: application/json';
			$headers[] = 'Content-Length: ' . \strlen($body);
		}
		if ($authenticated) {
			if (!$this->token) {
				throw new RockSignApiException('The RockSign API token is not configured.');
			}
			$headers[] = 'X-Auth-Token: ' . $this->token;
		}

		$response = $this->request(
			$method,
			self::BASE_URL . $path,
			$body,
			$headers,
			$maxResponseBytes,
			$mutation
		);
		$statusUnknown = $this->mutationStatusUnknown($response->status, $mutation);
		$decoded = [];
		if ($response->body) {
			try {
				$decoded = \json_decode($response->body, true, 64, JSON_THROW_ON_ERROR);
			} catch (\Throwable $e) {
				throw new RockSignApiException(
					'RockSign returned an invalid JSON response.',
					$response->status,
					$statusUnknown,
					$e
				);
			}
			if (!\is_array($decoded)) {
				throw new RockSignApiException(
					'RockSign returned an invalid JSON response.',
					$response->status,
					$statusUnknown
				);
			}
		}
		if (200 <= $response->status && 300 > $response->status && !$response->body) {
			throw new RockSignApiException(
				'RockSign returned an empty JSON response.',
				$response->status,
				$statusUnknown
			);
		}

		if (200 > $response->status || 300 <= $response->status) {
			$message = \is_string($decoded['error'] ?? null) ? $decoded['error'] : 'Request failed';
			throw new RockSignApiException(
				"RockSign returned HTTP {$response->status}: {$message}",
				$response->status,
				$this->mutationStatusUnknown($response->status, $mutation)
			);
		}

		return $decoded;
	}

	public function downloadPdf(string $url, int $maxBytes) : string
	{
		if (!$this->downloadUrlAllowed($url)) {
			throw new RockSignApiException('RockSign returned an invalid document URL.');
		}

		$headers = [
			'Accept: application/pdf, application/octet-stream;q=0.8',
			'Accept-Encoding: identity',
			'X-Auth-Token: ' . $this->token
		];
		$response = $this->request('GET', $url, null, $headers, $maxBytes, false);
		if (200 !== $response->status) {
			throw new RockSignApiException("RockSign document download returned HTTP {$response->status}.", $response->status);
		}

		$contentType = \strtolower((string) ($response->getHeader('content-type') ?: ''));
		if ($contentType
			&& !\str_starts_with($contentType, 'application/pdf')
			&& !\str_starts_with($contentType, 'application/octet-stream')) {
			throw new RockSignApiException('RockSign returned a non-PDF document response.');
		}
		if (!\str_starts_with($response->body, '%PDF-')) {
			throw new RockSignApiException('RockSign returned invalid PDF bytes.');
		}

		return $response->body;
	}

	public function downloadUrlAllowed(string $url) : bool
	{
		$parts = \parse_url($url);
		return \is_array($parts)
			&& 'https' === \strtolower((string) ($parts['scheme'] ?? ''))
			&& 'sign.boompay.ca' === \strtolower((string) ($parts['host'] ?? ''))
			&& !isset($parts['user'])
			&& !isset($parts['pass'])
			&& !isset($parts['fragment'])
			&& (!isset($parts['port']) || 443 === (int) $parts['port'])
			&& \str_starts_with((string) ($parts['path'] ?? ''), '/');
	}

	public function signingUrlAllowed(string $url) : bool
	{
		$parts = \parse_url($url);
		return $this->downloadUrlAllowed($url)
			&& \is_array($parts)
			&& !isset($parts['query'])
			&& (bool) \preg_match('#^/s/[1-9A-HJ-NP-Za-km-z]{14}/?$#', (string) ($parts['path'] ?? ''));
	}

	private function request(
		string $method,
		string $url,
		?string $body,
		array $headers,
		int $maxResponseBytes,
		bool $mutation
	) : \SnappyMail\HTTP\Response {
		$request = ($this->requestFactory)();
		if (!$request instanceof \SnappyMail\HTTP\Request) {
			throw new \LogicException('The RockSign HTTP request factory is invalid.');
		}

		$request->timeout = 20;
		$request->max_redirects = 0;
		$request->verify_peer = true;
		$request->max_response_kb = (int) \ceil($maxResponseBytes / 1024);

		try {
			$response = $request->doRequest($method, $url, $body, $headers);
		} catch (\Throwable $e) {
			$message = $mutation
				? 'RockSign did not return a response; status is unknown.'
				: 'RockSign did not return a response.';
			throw new RockSignApiException($message, 0, $mutation, $e);
		}
		if (!$response) {
			$message = $mutation
				? 'RockSign did not return a response; status is unknown.'
				: 'RockSign did not return a response.';
			throw new RockSignApiException($message, 0, $mutation);
		}

		$contentLength = $response->getHeader('content-length');
		$contentLength = \is_array($contentLength) ? $contentLength[0] : $contentLength;
		if ((\is_numeric($contentLength) && (int) $contentLength > $maxResponseBytes)
			|| \strlen($response->body) >= $maxResponseBytes) {
			$statusUnknown = $this->mutationStatusUnknown($response->status, $mutation);
			throw new RockSignApiException(
				'RockSign response exceeded the allowed size.',
				$response->status,
				$statusUnknown
			);
		}

		return $response;
	}

	private function mutationStatusUnknown(int $status, bool $mutation) : bool
	{
		return $mutation && (
			(200 <= $status && 400 > $status)
			|| 408 === $status
			|| 425 === $status
			|| 500 <= $status
		);
	}

	private function mask(#[\SensitiveParameter] string $value) : void
	{
		if ($value && $this->maskSecret) {
			($this->maskSecret)($value);
		}
	}
}
