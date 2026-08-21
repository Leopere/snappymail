<?php

namespace RainLoop\Actions;

use MailSo\Imap\Enumerations\FetchType;
use MailSo\Imap\SequenceSet;
use MailSo\Mail\MessageListParams;
use MailSo\Mime\Message as MimeMessage;
use RainLoop\Exceptions\ClientException;
use RainLoop\Notifications;
use RainLoop\Snooze\Store;

trait Snooze
{
	public function DoSnoozeCreate() : array
	{
		$account = $this->initMailClientConnection();
		$folder = $this->snoozeFolderParam('folder');
		if (0 === \strcasecmp($folder, Store::FOLDER)) {
			$this->snoozeInvalid('A message already in Snoozed cannot be snoozed again.');
		}

		$wakeAt = $this->snoozeWakeAt();
		$seedUid = $this->snoozeSeedUid();
		$explicitUids = $this->snoozeUidList($this->GetActionParam('uids', ''), true);
		if (0 >= $seedUid && !$explicitUids) {
			$this->snoozeInvalid('A message UID is required.');
		}

		$this->snoozeEnsureFolder();
		$sourceInfo = $this->ImapClient()->FolderStatusAndSelect($folder);
		$uids = $this->snoozeThreadUids($folder, $explicitUids ?: [$seedUid]);
		$messages = $this->snoozeMessageIdentities($folder, $uids);
		$destinationBefore = $this->snoozeFindByMessageIds(Store::FOLDER, \array_column($messages, 'messageId'));

		$now = \time();
		$claimToken = \bin2hex(\random_bytes(16));
		$record = [
			'id' => \bin2hex(\random_bytes(16)),
			'status' => 'moving',
			'sourceFolder' => $folder,
			'sourceUidValidity' => (int) ($sourceInfo->UIDVALIDITY ?? 0),
			'sourceUids' => $uids,
			'snoozedFolder' => Store::FOLDER,
			'snoozedUidValidity' => 0,
			'destinationUids' => [],
			'messages' => $messages,
			'wakeAt' => $wakeAt,
			'createdAt' => $now,
			'updatedAt' => $now,
			'claimToken' => $claimToken,
			'claimedAt' => $now,
			'reminderStatus' => 'pending'
		];

		$store = new Store($this->LocalStorageProvider(), $account);
		try {
			$store->insert($record);
		} catch (\Throwable $exception) {
			throw new ClientException(Notifications::UnknownError, $exception);
		}

		try {
			$this->ImapClient()->MessageMove($folder, Store::FOLDER, new SequenceSet($uids));
		} catch (\Throwable $exception) {
			$record['status'] = 'failed';
			$record['lastError'] = 'move_failed';
			$store->finish($record, $claimToken);
			throw new ClientException(Notifications::CantMoveMessage, $exception);
		}

		try {
			$destinationInfo = $this->ImapClient()->FolderStatusAndSelect(Store::FOLDER);
			$destinationAfter = $this->snoozeFindByMessageIds(Store::FOLDER, \array_column($messages, 'messageId'));
			$record['snoozedUidValidity'] = (int) ($destinationInfo->UIDVALIDITY ?? 0);
			$record['status'] = 'active';
			$record['lastError'] = '';
			try {
				$record['destinationUids'] = $this->snoozeNewDestinationUids(
					$messages,
					$destinationBefore,
					$destinationAfter
				);
			} catch (\Throwable $exception) {
				// Message-IDs remain a safe recovery identity when an IMAP server
				// omits or races destination UID discovery.
				$record['destinationUids'] = [];
				$record['lastError'] = 'destination_uid_unresolved';
			}
			$stored = $store->finish($record, $claimToken);
			if (!$stored) {
				throw new \RuntimeException('The snooze move lost its storage claim.');
			}
			return $this->DefaultResponse($this->snoozePublicRecord($stored));
		} catch (\Throwable $exception) {
			// The IMAP move has already succeeded. Keep this recoverable instead
			// of misreporting it as a failed move that may be retried by the UI.
			$record['status'] = 'active';
			$record['lastError'] = 'journal_finalize_failed';
			$store->finish($record, $claimToken);
			throw new ClientException(Notifications::UnknownError, $exception);
		}
	}

	public function DoSnoozeList() : array
	{
		$account = $this->getAccountFromToken();
		$records = (new Store($this->LocalStorageProvider(), $account))->all();
		\usort($records, static fn(array $a, array $b) : int =>
			((int) ($a['wakeAt'] ?? 0)) <=> ((int) ($b['wakeAt'] ?? 0))
		);
		return $this->DefaultResponse(\array_map([$this, 'snoozePublicRecord'], $records));
	}

	public function DoSnoozeCancel() : array
	{
		$account = $this->initMailClientConnection();
		$id = $this->snoozeIdParam();
		$store = new Store($this->LocalStorageProvider(), $account);
		$record = $store->claim($id, 'cancel');
		if (!$record) {
			$this->snoozeInvalid('The snooze is busy or does not exist.');
		}
		if (\in_array($record['status'] ?? '', ['restored', 'cancelled', 'failed'], true)) {
			return $this->DefaultResponse($this->snoozePublicRecord($record));
		}

		$record = $this->snoozeRestore($store, $record, false);
		return $this->DefaultResponse($this->snoozePublicRecord($record));
	}

	public function DoSnoozeProcessDue() : array
	{
		$account = $this->getAccountFromToken();
		$store = new Store($this->LocalStorageProvider(), $account);
		$claimed = $store->claimDue(\time());
		if (!$claimed) {
			return $this->DefaultResponse([]);
		}
		$this->initMailClientConnection();
		$events = [];
		foreach ($claimed as $record) {
			try {
				$events[] = $this->snoozePublicRecord($this->snoozeRestore($store, $record, true));
			} catch (\Throwable $exception) {
				$this->logException($exception);
				$events[] = [
					'id' => (string) ($record['id'] ?? ''),
					'status' => 'failed',
					'lastError' => 'restore_failed'
				];
			}
		}
		return $this->DefaultResponse($events);
	}

	private function snoozeRestore(Store $store, array $record, bool $sendReminder) : array
	{
		$claimToken = (string) ($record['claimToken'] ?? '');
		try {
			$currentInfo = $this->ImapClient()->FolderStatusAndSelect(Store::FOLDER);
			$uids = [];
			if ((int) ($record['snoozedUidValidity'] ?? 0)
				&& (int) ($record['snoozedUidValidity'] ?? 0) === (int) ($currentInfo->UIDVALIDITY ?? 0)
			) {
				$uids = $this->snoozeUidList($record['destinationUids'] ?? []);
			}

			if (!$uids) {
				$found = $this->snoozeFindByMessageIds(
					Store::FOLDER,
					\array_column($record['messages'] ?? [], 'messageId')
				);
				$uids = $this->snoozeResolvedUids($record['messages'] ?? [], $found);
			}

			$sourceFolder = $this->snoozeValidatedFolder((string) ($record['sourceFolder'] ?? ''));
			$sourceBefore = $this->snoozeFindByMessageIds(
				$sourceFolder,
				\array_column($record['messages'] ?? [], 'messageId')
			);
			if ($uids) {
				$this->ImapClient()->MessageMove(Store::FOLDER, $sourceFolder, new SequenceSet($uids));
			}
			$sourceAfter = $this->snoozeFindByMessageIds(
				$sourceFolder,
				\array_column($record['messages'] ?? [], 'messageId')
			);
			$record['restoredUids'] = $this->snoozeNewDestinationUids(
				$record['messages'] ?? [],
				$sourceBefore,
				$sourceAfter,
				false
			);
			$record['deepLink'] = $this->snoozeDeepLink($sourceFolder, (int) ($record['restoredUids'][0] ?? 0));
			$record['status'] = 'cancel' === ($record['restoreReason'] ?? '') ? 'cancelled' : 'restored';
			$record['restoredAt'] = \time();
			$record['lastError'] = '';
			$record['reminderStatus'] = $sendReminder ? 'sending' : 'cancelled';
			$stored = $store->finish($record, $claimToken);
			if (!$stored) {
				throw new \RuntimeException('The snooze restore lost its storage claim.');
			}

			if ($sendReminder) {
				$stored = $this->snoozeSendReminder($store, $stored);
			}
			return $stored;
		} catch (\Throwable $exception) {
			$record['status'] = 'failed';
			$record['lastError'] = 'restore_failed';
			$store->finish($record, $claimToken);
			throw $exception;
		}
	}

	private function snoozeSendReminder(Store $store, array $record) : array
	{
		// `sending` is an at-most-once marker: a lost SMTP response must not cause
		// the next due pass to send a duplicate reminder.
		$stream = null;
		try {
			$account = $this->getAccountFromToken();
			$email = $account->Email();
			$message = new MimeMessage();
			if ($this->Config()->Get('security', 'hide_x_mailer_header', true)) {
				$message->DoesNotAddDefaultXMailer();
			}
			$message->SetFrom(new \MailSo\Mime\Email($email));
			$message->SetTo(new \MailSo\Mime\EmailCollection($email));
			$message->RegenerateMessageId((string) \substr(\strrchr($email, '@') ?: '', 1));
			$subject = $this->snoozeReminderSubject($record);
			$message->SetSubject('Reminder: ' . $subject);
			$message->SetCustomHeader('Auto-Submitted', 'auto-generated');
			$message->SetCustomHeader('X-SnappyMail-Snooze-ID', (string) $record['id']);
			$message->SetCustomHeader('X-SnappyMail-Deep-Link', (string) ($record['deepLink'] ?? ''));
			$messageIds = \array_column($record['messages'] ?? [], 'messageId');
			if ($messageIds) {
				$message->SetInReplyTo((string) $messageIds[0]);
				$message->SetReferences(\implode(' ', $messageIds));
			}
			$message->addPlain("This snoozed conversation is due.\r\n\r\nOpen it in SnappyMail: " . ($record['deepLink'] ?? '#/mailbox'));

			$stream = \MailSo\Base\ResourceRegistry::CreateMemoryResource();
			$size = \MailSo\Base\Utils::WriteStream($message->ToStream(true), $stream, 8192, true, true);
			if (false === $size) {
				throw new \RuntimeException('Could not build reminder message.');
			}
			$this->smtpSendMessage($account, $message, $stream, $size, false);
			$record['reminderStatus'] = 'sent';
			$record['reminderSentAt'] = \time();
		} catch (\Throwable $exception) {
			$record['reminderStatus'] = 'unknown';
			$record['lastError'] = 'reminder_status_unknown';
			$this->logException($exception);
		} finally {
			\is_resource($stream) && \fclose($stream);
		}

		// The restore is already committed. Save only the at-most-once reminder
		// result; due processing never claims terminal records again.
		return $store->update((string) $record['id'], static function (array $current) use ($record) : array {
			$current['reminderStatus'] = $record['reminderStatus'];
			$current['lastError'] = $record['lastError'] ?? '';
			if (isset($record['reminderSentAt'])) {
				$current['reminderSentAt'] = $record['reminderSentAt'];
			}
			return $current;
		}) ?: $record;
	}

	private function snoozeThreadUids(string $folder, array $seedUids) : array
	{
		$seedUids = $this->snoozeUidList($seedUids);
		if (!$seedUids) {
			$this->snoozeInvalid('A valid message UID is required.');
		}
		$this->ImapClient()->FolderExamine($folder);
		$algorithm = MessageListParams::resolveThreadAlgorithm(
			'REFS',
			$this->ImapClient()->Capability() ?: []
		);
		if (!$algorithm) {
			return $seedUids;
		}

		$result = $seedUids;
		foreach ($this->ImapClient()->MessageThread('ALL', $algorithm) as $thread) {
			$uids = [];
			\array_walk_recursive((array) $thread, static function ($uid) use (&$uids) : void {
				\is_numeric($uid) && 0 < (int) $uid && $uids[] = (int) $uid;
			});
			if (\array_intersect($seedUids, $uids)) {
				$result = \array_merge($result, $uids);
			}
		}
		return $this->snoozeUidList($result);
	}

	private function snoozeMessageIdentities(string $folder, array $uids) : array
	{
		$this->ImapClient()->FolderExamine($folder);
		$responses = $this->ImapClient()->Fetch(
			[FetchType::UID, FetchType::ENVELOPE],
			(string) new SequenceSet($uids),
			true
		);
		$messages = [];
		foreach ($responses as $response) {
			$uid = (int) $response->GetFetchValue(FetchType::UID);
			$messageId = \trim((string) $response->GetFetchEnvelopeValue(9, ''));
			if (!$uid || !$messageId || 998 < \strlen($messageId) || \preg_match('/[\x00-\x1F\x7F]/', $messageId)) {
				$this->snoozeInvalid('Every snoozed message must have a safe Message-ID.');
			}
			$messages[$uid] = [
				'sourceUid' => $uid,
				'messageId' => $messageId
			];
		}
		if (\count($messages) !== \count($uids)) {
			$this->snoozeInvalid('One or more messages no longer exist.');
		}
		\ksort($messages);
		return \array_values($messages);
	}

	private function snoozeFindByMessageIds(string $folder, array $messageIds) : array
	{
		$this->ImapClient()->FolderExamine($folder);
		$result = [];
		foreach (\array_values(\array_unique($messageIds)) as $messageId) {
			$messageId = (string) $messageId;
			if (!$messageId || 998 < \strlen($messageId) || \preg_match('/[\x00-\x1F\x7F]/', $messageId)) {
				continue;
			}
			$criteria = 'HEADER Message-ID ' . $this->ImapClient()->EscapeString($messageId);
			$result[$messageId] = \array_values(\array_map('intval', $this->ImapClient()->MessageSearch($criteria)));
		}
		return $result;
	}

	private function snoozeNewDestinationUids(
		array $messages,
		array $before,
		array $after,
		bool $requireAll = true
	) : array {
		$result = [];
		$needed = \array_count_values(\array_column($messages, 'messageId'));
		foreach ($needed as $messageId => $count) {
			$new = \array_values(\array_diff($after[$messageId] ?? [], $before[$messageId] ?? []));
			if ($requireAll && \count($new) !== $count) {
				throw new \RuntimeException('Could not resolve moved message UIDs safely.');
			}
			$result = \array_merge($result, \array_slice($new, 0, $count));
		}
		return $this->snoozeUidList($result);
	}

	private function snoozeResolvedUids(array $messages, array $found) : array
	{
		$result = [];
		$needed = \array_count_values(\array_column($messages, 'messageId'));
		foreach ($needed as $messageId => $count) {
			$matches = $found[$messageId] ?? [];
			if ($count < \count($matches)) {
				throw new \RuntimeException('Message identity is ambiguous in Snoozed.');
			}
			$result = \array_merge($result, $matches);
		}
		return $this->snoozeUidList($result);
	}

	private function snoozeEnsureFolder() : void
	{
		$folders = $this->ImapClient()->FolderStatusList(Store::FOLDER, '');
		if (!isset($folders[Store::FOLDER])) {
			try {
				$this->MailClient()->FolderCreate(Store::FOLDER, '', true);
			} catch (\Throwable $exception) {
				$folders = $this->ImapClient()->FolderStatusList(Store::FOLDER, '');
				if (!isset($folders[Store::FOLDER])) {
					throw $exception;
				}
			}
		}
	}

	private function snoozeUidList($value, bool $strict = false) : array
	{
		$values = \is_array($value) ? $value : \explode(',', (string) $value);
		$uids = [];
		foreach ($values as $uid) {
			if ('' === $uid || null === $uid) {
				continue;
			}
			if (!\is_int($uid) && (!\is_string($uid) || !\preg_match('/^[1-9][0-9]*$/D', $uid))) {
				if ($strict) {
					$this->snoozeInvalid('Message UIDs must be positive integers.');
				}
				continue;
			}
			$uid = (int) $uid;
			$uid && $uids[$uid] = $uid;
		}
		$uids = \array_values($uids);
		\sort($uids, \SORT_NUMERIC);
		if (100 < \count($uids)) {
			$this->snoozeInvalid('A snoozed conversation may contain at most 100 messages.');
		}
		return $uids;
	}

	private function snoozeSeedUid() : int
	{
		$value = $this->GetActionParam('uid', 0);
		if (0 === $value || '0' === $value || '' === $value || null === $value) {
			return 0;
		}
		if (!\is_int($value) && (!\is_string($value) || !\preg_match('/^[1-9][0-9]*$/D', $value))) {
			$this->snoozeInvalid('A valid message UID is required.');
		}
		return (int) $value;
	}

	private function snoozeWakeAt() : int
	{
		$value = $this->GetActionParam('wakeAt', 0);
		if (!\is_int($value) && (!\is_string($value) || !\preg_match('/^[1-9][0-9]*$/D', $value))) {
			$this->snoozeInvalid('Wake time must be a Unix timestamp.');
		}
		$wakeAt = (int) $value;
		$now = \time();
		if ($wakeAt < $now + 60 || $wakeAt > $now + 31536000) {
			$this->snoozeInvalid('Wake time must be between one minute and one year from now.');
		}
		return $wakeAt;
	}

	private function snoozeIdParam() : string
	{
		$id = \strtolower(\trim((string) $this->GetActionParam('id', '')));
		if (!\preg_match('/^[a-f0-9]{32}$/D', $id)) {
			$this->snoozeInvalid('A valid snooze ID is required.');
		}
		return $id;
	}

	private function snoozeFolderParam(string $name) : string
	{
		return $this->snoozeValidatedFolder((string) $this->GetActionParam($name, ''));
	}

	private function snoozeValidatedFolder(string $folder) : string
	{
		$folder = \trim($folder);
		if (!$folder || 512 < \strlen($folder) || \preg_match('/[\x00-\x1F\x7F]/', $folder)) {
			$this->snoozeInvalid('A valid source folder is required.');
		}
		return $folder;
	}

	private function snoozeDeepLink(string $folder, int $uid) : string
	{
		return '#/mailbox/' . \rawurlencode($folder) . ($uid ? '/m' . $uid : '');
	}

	private function snoozeReminderSubject(array $record) : string
	{
		$folder = (string) ($record['sourceFolder'] ?? '');
		$uid = (int) ($record['restoredUids'][0] ?? 0);
		if (!$folder || !$uid) {
			return 'Snoozed conversation';
		}
		try {
			$this->ImapClient()->FolderExamine($folder);
			$responses = $this->ImapClient()->Fetch([FetchType::ENVELOPE], (string) $uid, true);
			$raw = isset($responses[0]) ? (string) $responses[0]->GetFetchEnvelopeValue(1, '') : '';
			$subject = \MailSo\Base\Utils::DecodeHeaderValue($raw);
			$subject = \preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $subject);
			return \mb_substr(\trim($subject), 0, 180) ?: 'Snoozed conversation';
		} catch (\Throwable $exception) {
			return 'Snoozed conversation';
		}
	}

	private function snoozePublicRecord(array $record) : array
	{
		unset($record['claimToken'], $record['claimedAt']);
		return $record;
	}

	private function snoozeInvalid(string $message) : void
	{
		throw new ClientException(Notifications::InvalidInputArgument, null, $message);
	}
}
