<?php

declare(strict_types=1);

$root = getenv('SNAPPYMAIL_SOURCE_ROOT') ?: dirname(__DIR__, 2);
spl_autoload_register(static function (string $class) use ($root) : void {
	$file = $root . '/snappymail/v/0.0.0/app/libraries/' . str_replace('\\', '/', $class) . '.php';
	if (is_file($file)) {
		require_once $file;
	}
});

use MailSo\Imap\Enumerations\FetchType;
use MailSo\Imap\FetchResponse;
use MailSo\Imap\FolderInformation;
use MailSo\Imap\ImapClient;
use MailSo\Imap\Response;
use MailSo\Imap\ResponseCollection;
use MailSo\Imap\SequenceSet;
use MailSo\Mail\MailClient;
use MailSo\Mail\MessageListParams;

function check(bool $condition, string $message) : void
{
	if (!$condition) {
		throw new RuntimeException($message);
	}
}

// The production MailClient, MIME parser and flag writer run against a deterministic IMAP transport.
final class ReceiptImap extends ImapClient
{
	public string $folder = '';
	public bool $sentKeywords = true;
	public bool $failStore = false;
	public array $sent = [20 => '<receipt-test@example.test>'];
	public array $flags = [];
	public array $writes = [];
	public string $receiptBody;

	public function __construct(public string $kind)
	{
		$this->receiptBody = 'delivery' === $kind
			? "Message-ID: <receipt-test@example.test>\r\n"
			: "Original-Message-ID: <receipt-test@example.test>\r\nDisposition: manual-action/MDN-sent-manually; displayed\r\n";
	}

	public function FolderSelect(string $sFolderName, bool $bForceReselect = false) : FolderInformation
	{
		$this->folder = $sFolderName;
		$info = new FolderInformation($sFolderName, true);
		$info->PermanentFlags = 'Sent' === $sFolderName && !$this->sentKeywords ? ['\\Seen'] : ['\\*'];
		// Stop MessageList after its real receipt-processing and folder-selection path.
		$info->MESSAGES = 0;
		return $info;
	}

	public function FolderExamine(string $sFolderName, bool $bForceReselect = false) : FolderInformation
	{
		return $this->FolderSelect($sFolderName);
	}

	public function FolderStatusAndSelect(string $sFolderName) : FolderInformation
	{
		return $this->FolderSelect($sFolderName);
	}

	public function MessageSearch(string $sSearchCriterias, bool $bReturnUid = true) : array
	{
		if ('Sent' === $this->folder) {
			check(str_starts_with($sSearchCriterias, 'HEADER Message-ID '), 'Sent correlation must search Message-ID.');
			// IMAP HEADER search can return a substring match; the client must verify it.
			return array_keys($this->sent);
		}
		check('INBOX' === $this->folder, 'Receipts must be read from Inbox, even when opening Sent.');
		$kind = str_contains($sSearchCriterias, 'disposition-notification') ? 'read' : 'delivery';
		preg_match('/^UNKEYWORD (\S+)/', $sSearchCriterias, $match);
		$processed = $match[1] ?? '\\Seen';
		return $this->kind === $kind && !$this->hasFlag('INBOX', 10, $processed) ? [10] : [];
	}

	public function Fetch(array $aInputFetchItems, string $sIndexRange, bool $bIndexIsUid) : array
	{
		check($bIndexIsUid, 'Receipt correlation must use stable UIDs.');
		$responses = [];
		foreach (explode(',', $sIndexRange) as $segment) {
			$bounds = array_map('intval', explode(':', $segment));
			foreach (range($bounds[0], $bounds[1] ?? $bounds[0]) as $uid) {
				$values = [FetchType::UID, $uid];
				if ('Sent' === $this->folder) {
					check(in_array('BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]', $aInputFetchItems, true),
						'Candidate headers must be fetched without changing their Seen state.');
					$values = array_merge($values, ['BODY[HEADER.FIELDS (MESSAGE-ID)]', "Message-ID: {$this->sent[$uid]}\r\n"]);
				} elseif (in_array(FetchType::BODYSTRUCTURE, $aInputFetchItems, true)) {
					$type = 'delivery' === $this->kind ? ['text', 'rfc822-headers'] : ['message', 'disposition-notification'];
					$values = array_merge($values, [FetchType::BODYSTRUCTURE, array_merge($type, [null, null, null, '7bit', 100, 1])]);
				} else {
					$values = array_merge($values, ['BODY[1]', $this->receiptBody]);
				}
				$response = new Response;
				$response->ResponseList = ['*', $uid, 'FETCH', $values];
				$responses[] = new FetchResponse($response);
			}
		}
		return $responses;
	}

	public function MessageStoreFlag(SequenceSet $oRange, array $aInputStoreItems, string $sStoreAction) : ?ResponseCollection
	{
		if ('Sent' === $this->folder && $this->failStore) {
			throw new RuntimeException('Simulated Sent STORE failure');
		}
		foreach ($oRange->getArrayCopy() as $uid) {
			foreach ($aInputStoreItems as $flag) {
				$this->flags[$this->folder][$uid][$flag] = true;
				$this->writes[] = [$this->folder, $uid, $flag];
			}
		}
		return null;
	}

	public function hasFlag(string $folder, int $uid, string $flag) : bool
	{
		return $this->flags[$folder][$uid][$flag] ?? false;
	}
}

function listFolder(ReceiptImap $imap, string $folder = 'Sent') : void
{
	$client = new MailClient;
	(new ReflectionProperty(MailClient::class, 'oImapClient'))->setValue($client, $imap);
	$params = new MessageListParams;
	$params->sFolderName = $folder;
	$params->sDeliveryReceiptSentFolder = 'Sent';
	$params->bHideDeliveryReceipts = false;
	$collection = $client->MessageList($params);
	check($folder === $collection->FolderName && $folder === $imap->folder,
		'Receipt processing must restore the requested list folder.');
}

foreach (['delivery', 'read'] as $kind) {
	$success = 'read' === $kind ? '$ReadSuccess' : '$DeliverySuccess';
	$processed = 'read' === $kind ? '$ReadProcessedV2' : '$DeliveryProcessedV2';

	$imap = new ReceiptImap($kind);
	$imap->flags['INBOX'][10]['read' === $kind ? '$ReadProcessed' : '$DeliveryProcessed'] = true;
	listFolder($imap);
	check($imap->hasFlag('Sent', 20, $success), "$kind: opening Sent directly must re-link reports processed by the old implementation.");
	check($imap->hasFlag('INBOX', 10, $processed), "$kind: linked report must be durably processed.");
	check(['Sent', 20, $success] === $imap->writes[0], "$kind: success must persist before processing the report.");

	$imap = new ReceiptImap($kind);
	listFolder($imap, 'INBOX');
	check($imap->hasFlag('Sent', 20, $success), "$kind: visible Inbox reports must still update Sent.");

	$imap = new ReceiptImap($kind);
	$imap->sent = [];
	listFolder($imap);
	check(!$imap->hasFlag('INBOX', 10, $processed), "$kind: an unmatched valid report must remain pending.");
	$imap->sent = [20 => '<receipt-test@example.test>'];
	listFolder($imap);
	check($imap->hasFlag('Sent', 20, $success), "$kind: a delayed Sent copy must link on the next load.");

	$imap = new ReceiptImap($kind);
	$imap->sentKeywords = false;
	listFolder($imap);
	check(!$imap->hasFlag('INBOX', 10, $processed), "$kind: unsupported Sent keywords must leave reports pending.");
	$imap->sentKeywords = true;
	listFolder($imap);
	check($imap->hasFlag('Sent', 20, $success), "$kind: restored keyword support must allow retry.");

	$imap = new ReceiptImap($kind);
	$imap->sent = [20 => '<other@example.test>', 21 => '<receipt-test@example.test> <extra@example.test>'];
	listFolder($imap);
	check(!$imap->hasFlag('Sent', 20, $success) && !$imap->hasFlag('Sent', 21, $success),
		"$kind: substring search results must never mark a different message successful.");
	check(!$imap->hasFlag('INBOX', 10, $processed), "$kind: substring-only matches must remain pending.");

	$imap = new ReceiptImap($kind);
	$imap->sent = [20 => '<receipt-test@example.test>', 21 => '<receipt-test@example.test> <extra@example.test>'];
	listFolder($imap);
	check($imap->hasFlag('Sent', 20, $success) && !$imap->hasFlag('Sent', 21, $success),
		"$kind: one exact candidate must not cause other substring matches to be marked successful.");

	$imap = new ReceiptImap($kind);
	$imap->failStore = true;
	try {
		listFolder($imap);
		throw new RuntimeException('Expected Sent STORE failure');
	} catch (RuntimeException $exception) {
		check('Simulated Sent STORE failure' === $exception->getMessage(), 'Unexpected failure: ' . $exception->getMessage());
	}
	check(!$imap->hasFlag('INBOX', 10, $processed), "$kind: failed Sent flag writes must not consume the receipt.");

	$imap = new ReceiptImap($kind);
	$imap->receiptBody = "Subject: Malformed report\r\n";
	listFolder($imap);
	check($imap->hasFlag('INBOX', 10, $processed), "$kind: malformed reports may be completed without repeated parsing.");
	check(!$imap->hasFlag('Sent', 20, $success), "$kind: malformed reports must not mark a Sent message successful.");
}

echo "Delivery/read receipt linking regression checks passed\n";
