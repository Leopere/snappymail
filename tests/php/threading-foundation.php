<?php

declare(strict_types=1);

$root = \getenv('SNAPPYMAIL_SOURCE_ROOT') ?: \dirname(__DIR__, 2);
require $root . '/snappymail/v/0.0.0/app/libraries/MailSo/Mail/MessageListParams.php';

$assert = static function (bool $condition, string $message) : void {
	if (!$condition) {
		throw new \RuntimeException($message);
	}
};

use MailSo\Mail\MessageListParams;

$assert('REFS' === MessageListParams::normalizeThreadAlgorithm('refs'),
	'The preferred REFS algorithm must be normalized case-insensitively.');
$assert('REFS' === MessageListParams::normalizeThreadAlgorithm(''),
	'An empty legacy preference must normalize to REFS.');
$assert('REFS' === MessageListParams::normalizeThreadAlgorithm('invalid'),
	'An invalid client preference must not reach IMAP.');
$assert('REFERENCES' === MessageListParams::normalizeThreadAlgorithm('references'),
	'A supported explicit fallback must remain available.');
$assert('REFS' === MessageListParams::resolveThreadAlgorithm('', ['THREAD=ORDEREDSUBJECT', 'THREAD=REFS']),
	'The server resolver must prefer REFS when no valid preference exists.');
$assert('REFERENCES' === MessageListParams::resolveThreadAlgorithm('REFS', ['THREAD=REFERENCES']),
	'The resolver must fall back when REFS is unavailable.');
$assert('' === MessageListParams::resolveThreadAlgorithm('REFS', ['IMAP4REV1', 'SORT']),
	'The resolver must disable threading when the server advertises no thread algorithm.');

$params = new MessageListParams;
$assert('REFS' === $params->sThreadAlgorithm, 'New message lists must prefer REFS.');
$params->sFolderName = 'INBOX';
$params->bUseThreads = true;
$params->sThreadAlgorithm = 'REFS';
$refsHash = $params->hash();
$params->sThreadAlgorithm = 'ORDEREDSUBJECT';
$assert($refsHash !== $params->hash(), 'Message-list request hashes must distinguish thread algorithms.');

$mailClient = \file_get_contents(
	$root . '/snappymail/v/0.0.0/app/libraries/MailSo/Mail/MailClient.php'
);
$assert(false !== \strpos($mailClient, 'ThreadsMap/v2/{$sAlgorithm}/'),
	'Thread-map cache keys must include their resolved algorithm and cache version.');
$assert(false !== \strpos($mailClient, 'ThreadsOldUids/v2/{$sAlgorithm}/'),
	'Old-UID cache keys must include their resolved algorithm and cache version.');
$assert(2 === \preg_match_all('/ThreadsOldUids\\(\\s*\\$oParams->sThreadAlgorithm,/', $mailClient),
	'Every old-UID calculation must receive the resolved algorithm.');

$application = \file_get_contents(
	$root . '/snappymail/v/0.0.0/app/libraries/RainLoop/Config/Application.php'
);
$assert(1 === \preg_match("/'mail_use_threads'\\s*=>\\s*array\\(true\\)/", $application),
	'Threading must be enabled by default.');

$accounts = \file_get_contents(
	$root . '/snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Accounts.php'
);
$assert(false !== \strpos($accounts, "'threadAlgorithm' => 'REFS'"),
	'Account bootstrap data must expose the normalized REFS preference.');

$entrypoint = \file_get_contents($root . '/.docker/release/files/entrypoint.sh');
$assert(false !== \strpos($entrypoint, "s/^mail_use_threads = .*/mail_use_threads = On/"),
	'Container startup must migrate the persisted legacy default to threaded view.');

echo "Threading foundation regression checks passed\n";
