<?php

require_once __DIR__ . '/RockSignClient.php';

final class RocksignPlugin extends \RainLoop\Plugins\AbstractPlugin
{
	public const
		NAME = 'RockSign',
		VERSION = '1.0.1',
		RELEASE = '2026-07-10',
		REQUIRED = '2.38.0',
		CATEGORY = 'Integrations',
		DESCRIPTION = 'Send signing requests and certify, retrieve, or verify PDFs through BoomPay RockSign.';

	private const MAX_PDF_BYTES = 26214400;
	private const MAX_STAGED_PDF_BYTES = 31457280;
	private const MAX_SIGN_RESPONSE_BYTES = 44040192;

	public function Init() : void
	{
		$this->UseLangs(true);
		$this->addJs('js/rocksign.js');
		$this->addJs('js/admin.js', true);
		$this->addCss('style.css');
		$this->addCss('style.css', true);
		$this->addTemplate('templates/PopupsRockSign.html');

		$this->addJsonHook('RockSignTestConnection', 'RockSignTestConnection');
		$this->addJsonHook('RockSignTemplates', 'RockSignTemplates');
		$this->addJsonHook('RockSignCreateSubmission', 'RockSignCreateSubmission');
		$this->addJsonHook('RockSignCertifyPdf', 'RockSignCertifyPdf');
		$this->addJsonHook('RockSignCompletedSubmissions', 'RockSignCompletedSubmissions');
		$this->addJsonHook('RockSignSubmissionFiles', 'RockSignSubmissionFiles');
		$this->addJsonHook('RockSignAttachCompletedPdf', 'RockSignAttachCompletedPdf');
		$this->addJsonHook('RockSignVerifyPdf', 'RockSignVerifyPdf');
	}

	protected function configMapping() : array
	{
		return [
			\RainLoop\Plugins\Property::NewInstance('api_token')
				->SetLabel('API token')
				->SetType(\RainLoop\Enumerations\PluginPropertyType::PASSWORD)
				->SetDescription('Token for a dedicated RockSign admin or editor integration user.')
				->SetEncrypted(),
			\RainLoop\Plugins\Property::NewInstance('allowed_mailboxes')
				->SetLabel('Authorized mailboxes')
				->SetType(\RainLoop\Enumerations\PluginPropertyType::STRING_TEXT)
				->SetDescription('Exact mailbox addresses, separated by commas or new lines.'),
			\RainLoop\Plugins\Property::NewInstance('allowed_template_ids')
				->SetLabel('Allowed template IDs')
				->SetType(\RainLoop\Enumerations\PluginPropertyType::STRING_TEXT)
				->SetDescription('Exact numeric RockSign template IDs, separated by commas or new lines.')
		];
	}

	public function FilterAppDataPluginSection(bool $bAdmin, bool $bAuth, array &$aConfig) : void
	{
		if (!$bAdmin) {
			$account = $bAuth ? $this->Manager()->Actions()->getAccountFromToken(false) : null;
			$allowed = (bool) ($account && $this->accountIsAllowed($account));
			$aConfig['enabled'] = $allowed;
			$aConfig['mailbox'] = $allowed ? \strtolower($account->Email()) : '';
			$aConfig['verification_url'] = RockSignClient::BASE_URL . '/public_pdf_verification';
		}
	}

	public function RockSignTestConnection() : array
	{
		$actions = $this->Manager()->Actions();
		if (!$actions instanceof \RainLoop\ActionsAdmin || !$actions->IsAdminLoggined(false)) {
			return $this->jsonResponse(__FUNCTION__, ['success' => false, 'error' => 'Administrator login required.']);
		}

		try {
			$user = $this->client()->json('GET', '/api/user');
			$capabilities = (array) ($user['capabilities'] ?? []);
			if (true !== ($capabilities['create_submission'] ?? false)
				|| true !== ($capabilities['sign_pdf'] ?? false)) {
				throw new \RuntimeException(
					'The token must belong to a RockSign administrator or editor with submission and PDF-signing access.'
				);
			}
			return $this->jsonResponse(__FUNCTION__, [
				'success' => true,
				'user' => \array_intersect_key($user, \array_flip(['id', 'first_name', 'last_name', 'email'])),
				'capabilities' => $capabilities
			]);
		} catch (\Throwable $e) {
			return $this->errorResponse(__FUNCTION__, $e);
		}
	}

	public function RockSignTemplates() : array
	{
		return $this->userResponse(__FUNCTION__, function ($account, RockSignClient $client) : array {
			$templates = [];
			foreach ($this->allowedTemplateIds() as $id) {
				$template = $client->json('GET', "/api/templates/{$id}");
				$templates[] = [
					'id' => (int) ($template['id'] ?? 0),
					'name' => (string) ($template['name'] ?? "Template {$id}"),
					'roles' => \array_values(\array_filter(\array_map(
						static fn($role) => \is_array($role) && !empty($role['name'])
							? ['name' => (string) $role['name']]
							: null,
						(array) ($template['submitters'] ?? [])
					)))
				];
			}
			return ['templates' => $templates];
		});
	}

	public function RockSignCreateSubmission() : array
	{
		return $this->userResponse(__FUNCTION__, function ($account, RockSignClient $client) : array {
			$templateId = $this->requireAllowedTemplateId((int) $this->jsonParam('template_id', 0));
			$template = $client->json('GET', "/api/templates/{$templateId}");
			$roles = [];
			foreach ((array) ($template['submitters'] ?? []) as $role) {
				if (\is_array($role) && !empty($role['name'])) {
					$roles[(string) $role['name']] = true;
				}
			}

			$submitted = $this->jsonParam('submitters', []);
			$submitted = \is_string($submitted) ? \json_decode($submitted, true) : $submitted;
			if (!\is_array($submitted) || !$submitted || 25 < \count($submitted)) {
				throw new \InvalidArgumentException('One to 25 signer assignments are required.');
			}

			$externalId = $this->mailboxExternalId($account->Email());
			$submitters = [];
			$seenRoles = [];
			foreach ($submitted as $item) {
				$role = \trim((string) ($item['role'] ?? ''));
				$email = \strtolower(\trim((string) ($item['email'] ?? '')));
				$name = \trim((string) ($item['name'] ?? ''));
				if (!isset($roles[$role]) || isset($seenRoles[$role])) {
					throw new \InvalidArgumentException('Every signer role must be allowed by the selected template and assigned once.');
				}
				if (!\filter_var($email, FILTER_VALIDATE_EMAIL)) {
					throw new \InvalidArgumentException("A valid email address is required for {$role}.");
				}
				$seenRoles[$role] = true;
				$submitters[] = [
					'role' => $role,
					'email' => $email,
					'name' => \mb_substr($name, 0, 200),
					'external_id' => $externalId
				];
			}
			if (\count($seenRoles) !== \count($roles)) {
				throw new \InvalidArgumentException('Every signer role in the selected template must be assigned exactly once.');
			}

			$delivery = (string) $this->jsonParam('delivery', 'rocksign');
			$sendEmail = 'snappymail' !== $delivery;
			if (!$sendEmail && 1 !== \count($submitters)) {
				throw new \InvalidArgumentException(
					'SnappyMail delivery is limited to one signer so private signing links are never shared.'
				);
			}
			$subject = \trim((string) $this->jsonParam('subject', ''));
			$body = \trim((string) $this->jsonParam('body', ''));
			if ($sendEmail && ($subject || $body) && !\str_contains($body, '{{submitter.link}}')) {
				throw new \InvalidArgumentException('A custom RockSign message must contain {{submitter.link}}.');
			}

			$request = [
				'template_id' => $templateId,
				'send_email' => $sendEmail,
				'reply_to' => $account->Email(),
				'submitters' => $submitters
			];
			if ($sendEmail && ($subject || $body)) {
				$request['message'] = ['subject' => $subject, 'body' => $body];
			}

			try {
				$result = $client->json('POST', '/api/submissions/init', $request, true, 2097152, true);
			} catch (RockSignApiException $e) {
				if ($e->statusUnknown()) {
					return ['created' => false, 'status_unknown' => true, 'error' => $e->getMessage()];
				}
				throw $e;
			}
			$submissionId = (int) ($result['id'] ?? 0);
			if (0 >= $submissionId) {
				return [
					'created' => false,
					'status_unknown' => true,
					'error' => 'RockSign returned an incomplete success response; check RockSign before trying again.'
				];
			}

			$links = [];
			$linkError = '';
			if (!$sendEmail) {
				$expected = $submitters[0];
				foreach ((array) ($result['submitters'] ?? []) as $submitter) {
					if (!\is_array($submitter)) {
						continue;
					}
					$link = (string) ($submitter['embed_src'] ?? '');
					$email = \strtolower(\trim((string) ($submitter['email'] ?? '')));
					$role = (string) ($submitter['role'] ?? '');
					if (!$link || $email !== $expected['email'] || $role !== $expected['role']
						|| (int) ($submitter['submission_id'] ?? 0) !== $submissionId
						|| (string) ($submitter['external_id'] ?? '') !== $expected['external_id']
						|| !$client->signingUrlAllowed($link)) {
						$linkError = 'RockSign created the submission but did not return a usable private signing link.';
						continue;
					}
					$this->Manager()->Actions()->logMask($link);
					$links[] = [
						'role' => $role,
						'email' => $email,
						'embed_src' => $link
					];
				}
				if (1 !== \count($links)) {
					$linkError = 'RockSign created the submission but did not return exactly one usable private signing link.';
				}
			}

			return [
				'created' => true,
				'status_unknown' => false,
				'submission_id' => $submissionId,
				'delivery' => $sendEmail ? 'rocksign' : 'snappymail',
				'links' => $links,
				'link_error' => $linkError
			];
		});
	}

	public function RockSignCertifyPdf() : array
	{
		return $this->userResponse(__FUNCTION__, function ($account, RockSignClient $client) : array {
			[$pdf, $sourceName] = $this->readPdf(
				$account,
				(string) $this->jsonParam('temp_name', ''),
				(string) $this->jsonParam('filename', '')
			);
			$reason = \mb_substr(\trim((string) $this->jsonParam('reason', '')), 0, 250);
			$reason = $reason ?: 'Certified through BoomPay RockSign';
			$result = $client->json('POST', '/api/tools/sign', [
				'file' => \base64_encode($pdf),
				'filename' => $sourceName,
				'reason' => $reason
			], true, self::MAX_SIGN_RESPONSE_BYTES, true);

			$signed = $this->decodePdf((string) ($result['data'] ?? ''));
			if (true !== ($result['signed_by_instance'] ?? false)
				|| !$this->hashMatches((string) ($result['sha256'] ?? ''), $signed)
				|| !$this->hashMatches((string) ($result['original_sha256'] ?? ''), $pdf)) {
				throw new \RuntimeException('RockSign did not return a valid signed-document assertion.');
			}

			$verification = $this->verifyBytes($client, $signed);
			if (true !== ($verification['signed_by_instance'] ?? false)) {
				throw new \RuntimeException('RockSign could not cryptographically verify the signed PDF bytes.');
			}

			$name = $this->signedFilename($sourceName);
			return [
				'attachment' => $this->stagePdf($account, $signed, $name),
				'verification' => $this->verificationSummary($verification)
			];
		});
	}

	public function RockSignCompletedSubmissions() : array
	{
		return $this->userResponse(__FUNCTION__, function ($account, RockSignClient $client) : array {
			$submissions = [];
			$externalId = \rawurlencode($this->mailboxExternalId($account->Email()));
			$basePath = "/api/submissions?status=completed&external_id={$externalId}&limit=100";
			$path = $basePath;
			$seenPaths = [];
			while ($path) {
				if (isset($seenPaths[$path])) {
					throw new \RuntimeException('RockSign returned a repeated submissions cursor.');
				}
				$seenPaths[$path] = true;
				$result = $client->json('GET', $path);
				foreach ((array) ($result['data'] ?? []) as $submission) {
					if (\is_array($submission) && $this->ownsSubmission($submission, $account->Email())) {
						$submissions[] = [
							'id' => (int) ($submission['id'] ?? 0),
							'template_name' => (string) ($submission['template']['name'] ?? 'Contract'),
							'completed_at' => (string) ($submission['completed_at'] ?? ''),
							'created_at' => (string) ($submission['created_at'] ?? '')
						];
					}
				}
				$next = (int) ($result['pagination']['next'] ?? 0);
				$path = $next ? "{$basePath}&after={$next}" : '';
			}
			return ['submissions' => $submissions];
		});
	}

	public function RockSignSubmissionFiles() : array
	{
		return $this->userResponse(__FUNCTION__, function ($account, RockSignClient $client) : array {
			$submission = $this->ownedCompletedSubmission($client, $account->Email(), (int) $this->jsonParam('submission_id', 0));
			$files = \array_map(static fn($file) => \array_diff_key($file, ['url' => true]), $this->submissionFiles($client, $submission));
			return ['files' => $files];
		});
	}

	public function RockSignAttachCompletedPdf() : array
	{
		return $this->userResponse(__FUNCTION__, function ($account, RockSignClient $client) : array {
			$submission = $this->ownedCompletedSubmission($client, $account->Email(), (int) $this->jsonParam('submission_id', 0));
			$key = (string) $this->jsonParam('file_key', '');
			$file = null;
			foreach ($this->submissionFiles($client, $submission) as $candidate) {
				if ($key === $candidate['key']) {
					$file = $candidate;
					break;
				}
			}
			if (!$file) {
				throw new \InvalidArgumentException('The selected completed contract file is not available.');
			}

			$pdf = $client->downloadPdf($file['url'], self::MAX_PDF_BYTES);
			$verification = $this->verifyBytes($client, $pdf);
			if (true !== ($verification['signed_by_instance'] ?? false)) {
				throw new \RuntimeException('RockSign could not verify the completed PDF bytes.');
			}
			return [
				'attachment' => $this->stagePdf($account, $pdf, $file['name']),
				'verification' => $this->verificationSummary($verification)
			];
		});
	}

	public function RockSignVerifyPdf() : array
	{
		return $this->userResponse(__FUNCTION__, function ($account, RockSignClient $client) : array {
			[$pdf] = $this->readPdf($account, (string) $this->jsonParam('temp_name', ''));
			return ['verification' => $this->verificationSummary($this->verifyBytes($client, $pdf))];
		});
	}

	private function userResponse(string $method, callable $callback) : array
	{
		try {
			$account = $this->requireAuthorizedAccount();
			$result = $callback($account, $this->client());
			return $this->jsonResponse($method, ['success' => true] + $result);
		} catch (\Throwable $e) {
			return $this->errorResponse($method, $e);
		}
	}

	private function errorResponse(string $method, \Throwable $e) : array
	{
		\SnappyMail\Log::warning('RockSign', $e::class);
		return $this->jsonResponse($method, [
			'success' => false,
			'error' => $e->getMessage() ?: 'RockSign request failed.'
		]);
	}

	private function client() : RockSignClient
	{
		$token = (string) $this->Config()->getDecrypted('plugin', 'api_token', '');
		$actions = $this->Manager()->Actions();
		return new RockSignClient($token, null, static fn(string $secret) => $actions->logMask($secret));
	}

	private function requireAuthorizedAccount() : \RainLoop\Model\Account
	{
		$account = $this->Manager()->Actions()->getAccountFromToken();
		if (!$account || !$this->accountIsAllowed($account)) {
			throw new \RuntimeException('This mailbox is not authorized to use RockSign.');
		}
		return $account;
	}

	private function accountIsAllowed(\RainLoop\Model\Account $account) : bool
	{
		$email = \strtolower(\trim($account->Email()));
		return $email
			&& (string) $this->Config()->getDecrypted('plugin', 'api_token', '')
			&& \in_array($email, $this->configuredList('allowed_mailboxes'), true);
	}

	private function configuredList(string $name) : array
	{
		$value = \strtolower((string) $this->Config()->Get('plugin', $name, ''));
		return \array_values(\array_unique(\array_filter(\preg_split('/[\s,;]+/', $value))));
	}

	private function allowedTemplateIds() : array
	{
		$ids = [];
		foreach ($this->configuredList('allowed_template_ids') as $value) {
			if (\preg_match('/^[1-9][0-9]*$/', $value)) {
				$ids[] = (int) $value;
			}
		}
		return \array_values(\array_unique($ids));
	}

	private function requireAllowedTemplateId(int $id) : int
	{
		if (!\in_array($id, $this->allowedTemplateIds(), true)) {
			throw new \InvalidArgumentException('The selected RockSign template is not allowed.');
		}
		return $id;
	}

	private function mailboxExternalId(string $email) : string
	{
		$email = \strtolower(\trim($email));
		$nonce = \substr(\hash_hmac('sha256', "rocksign-mailbox\0" . $email, APP_SALT), 0, 32);
		$mac = \hash_hmac('sha256', $nonce . "\0" . \strtolower($email), APP_SALT);
		return "sm1.{$nonce}.{$mac}";
	}

	private function ownsExternalId(string $externalId, string $email) : bool
	{
		if (!\preg_match('/^sm1\.([a-f0-9]{32})\.([a-f0-9]{64})$/', $externalId, $matches)) {
			return false;
		}
		$expected = \hash_hmac('sha256', $matches[1] . "\0" . \strtolower($email), APP_SALT);
		return \hash_equals($expected, $matches[2]);
	}

	private function ownsSubmission(array $submission, string $email) : bool
	{
		$submitters = (array) ($submission['submitters'] ?? []);
		return $submitters && !\array_filter(
			$submitters,
			fn($submitter) => !\is_array($submitter)
				|| !$this->ownsExternalId((string) ($submitter['external_id'] ?? ''), $email)
		);
	}

	private function ownedCompletedSubmission(RockSignClient $client, string $email, int $id) : array
	{
		if (0 >= $id) {
			throw new \InvalidArgumentException('A valid RockSign submission is required.');
		}
		$submission = $client->json('GET', "/api/submissions/{$id}?include=combined_document_url");
		if ('completed' !== ($submission['status'] ?? '') || !$this->ownsSubmission($submission, $email)) {
			throw new \RuntimeException('The completed submission is not owned by this mailbox.');
		}
		return $submission;
	}

	private function submissionFiles(RockSignClient $client, array $submission) : array
	{
		$id = (int) $submission['id'];
		$documents = $client->json('GET', "/api/submissions/{$id}/documents");
		$files = [];
		foreach ((array) ($documents['documents'] ?? []) as $index => $document) {
			if (\is_array($document)) {
				$url = (string) ($document['url'] ?? '');
			} else {
				$url = '';
			}
			if ($client->downloadUrlAllowed($url)) {
				$files[] = [
					'key' => "document:{$index}",
					'name' => $this->pdfFilename((string) ($document['name'] ?? "completed-document-{$index}.pdf")),
					'url' => $url
				];
			}
		}
		foreach ([
			'combined' => ['combined_document_url', 'combined-contract.pdf'],
			'audit' => ['audit_log_url', 'contract-audit-report.pdf']
		] as $key => [$field, $name]) {
			$url = (string) ($submission[$field] ?? '');
			if ($client->downloadUrlAllowed($url)) {
				$files[] = ['key' => $key, 'name' => $name, 'url' => $url];
			}
		}
		return $files;
	}

	private function readPdf(\RainLoop\Model\Account $account, string $tempName, string $suggestedName = '') : array
	{
		$files = $this->Manager()->Actions()->FilesProvider();
		$size = $tempName && $files->FileExists($account, $tempName) ? $files->FileSize($account, $tempName) : 0;
		if (0 >= $size || self::MAX_PDF_BYTES < $size) {
			throw new \InvalidArgumentException('The selected PDF is missing or exceeds 25 MB.');
		}

		$stream = $files->GetFile($account, $tempName);
		if (!\is_resource($stream)) {
			throw new \RuntimeException('The selected PDF could not be read.');
		}
		try {
			$pdf = (string) \stream_get_contents($stream, self::MAX_PDF_BYTES + 1);
		} finally {
			\fclose($stream);
		}
		if (\strlen($pdf) !== $size || !\str_starts_with($pdf, '%PDF-')) {
			throw new \InvalidArgumentException('The selected attachment is not a valid PDF.');
		}

		return [$pdf, $this->pdfFilename($suggestedName ?: 'document.pdf')];
	}

	private function decodePdf(string $encoded) : string
	{
		$encoded = \preg_replace('/\s+/', '', $encoded);
		$pdf = \base64_decode($encoded, true);
		if (!\is_string($pdf) || self::MAX_STAGED_PDF_BYTES < \strlen($pdf) || !\str_starts_with($pdf, '%PDF-')) {
			throw new \RuntimeException('RockSign returned invalid signed PDF data.');
		}
		return $pdf;
	}

	private function stagePdf(\RainLoop\Model\Account $account, string $pdf, string $name) : array
	{
		if (self::MAX_STAGED_PDF_BYTES < \strlen($pdf) || !\str_starts_with($pdf, '%PDF-')) {
			throw new \RuntimeException('The RockSign PDF is invalid or exceeds 30 MB.');
		}
		$stream = \fopen('php://temp', 'w+b');
		if (!\is_resource($stream) || \strlen($pdf) !== \fwrite($stream, $pdf)) {
			throw new \RuntimeException('The PDF could not be prepared for attachment.');
		}
		\rewind($stream);
		$tempName = 'rocksign-' . \bin2hex(\random_bytes(20));
		try {
			if (!$this->Manager()->Actions()->FilesProvider()->PutFile($account, $tempName, $stream)) {
				throw new \RuntimeException('The PDF could not be staged as an attachment.');
			}
		} finally {
			\fclose($stream);
		}

		return [
			'tempName' => $tempName,
			'name' => $this->pdfFilename($name),
			'mimeType' => 'application/pdf',
			'size' => \strlen($pdf),
			'sha256' => \hash('sha256', $pdf)
		];
	}

	private function verifyBytes(RockSignClient $client, string $pdf) : array
	{
		return $client->json('POST', '/api/tools/verify', ['file' => \base64_encode($pdf)], true, 1048576);
	}

	private function verificationSummary(array $result) : array
	{
		return \array_intersect_key($result, \array_flip([
			'signed_by_instance', 'exact_document_match', 'document_source', 'checksum_status',
			'assertion_status', 'embedded_assertion_status', 'chain_status', 'sha256',
			'signatures_count'
		]));
	}

	private function hashMatches(string $encodedHash, string $data) : bool
	{
		$expected = \rtrim(\strtr(\base64_encode(\hash('sha256', $data, true)), '+/', '-_'), '=');
		return $encodedHash && \hash_equals($expected, \rtrim($encodedHash, '='));
	}

	private function signedFilename(string $name) : string
	{
		$name = \preg_replace('/\.pdf$/i', '', $this->pdfFilename($name));
		return $name . '-rocksign-signed.pdf';
	}

	private function pdfFilename(string $name) : string
	{
		$name = \MailSo\Base\Utils::SecureFileName(\mb_substr($name, 0, 180)) ?: 'document.pdf';
		return \str_ends_with(\strtolower($name), '.pdf') ? $name : $name . '.pdf';
	}
}
