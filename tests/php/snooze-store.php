<?php

declare(strict_types=1);

namespace RainLoop\Model {
	class Account
	{
		public function __construct(public string $id, public string $password = '')
		{
		}
	}
}

namespace RainLoop\Providers\Storage\Enumerations {
	abstract class StorageType
	{
		public const CONFIG = 1;
	}
}

namespace RainLoop\Providers {
	class Storage
	{
		public function __construct(private string $path)
		{
			\is_dir($path) || \mkdir($path, 0700, true);
		}

		public function Put($account, int $type, string $key, string $value) : bool
		{
			return false !== \file_put_contents($this->accountPath($account) . $key, $value);
		}

		public function Get($account, int $type, string $key, $default = false)
		{
			$file = $this->accountPath($account) . $key;
			return \is_file($file) ? \file_get_contents($file) : $default;
		}

		public function GenerateFilePath($account, int $type, bool $create = false) : string
		{
			return $this->accountPath($account);
		}

		private function accountPath($account) : string
		{
			$path = $this->path . '/' . \hash('sha256', $account->id) . '/';
			\is_dir($path) || \mkdir($path, 0700, true);
			return $path;
		}
	}
}

namespace {

$root = \getenv('SNAPPYMAIL_SOURCE_ROOT') ?: \dirname(__DIR__, 2);
require $root . '/snappymail/v/0.0.0/app/libraries/RainLoop/Snooze/Store.php';

$assert = static function (bool $condition, string $message) : void {
	if (!$condition) {
		throw new \RuntimeException($message);
	}
};

$data = \sys_get_temp_dir() . '/snappymail-snooze-' . \bin2hex(\random_bytes(6));
$storage = new \RainLoop\Providers\Storage($data);
$account = new \RainLoop\Model\Account('alice@example.test', 'must-not-be-stored');
$store = new \RainLoop\Snooze\Store($storage, $account);
$now = \time();
$record = [
	'id' => \str_repeat('a', 32),
	'status' => 'active',
	'sourceFolder' => 'INBOX',
	'sourceUidValidity' => 10,
	'sourceUids' => [4, 5],
	'snoozedFolder' => 'Snoozed',
	'snoozedUidValidity' => 11,
	'destinationUids' => [20, 21],
	'messages' => [
		['sourceUid' => 4, 'messageId' => '<one@example.test>'],
		['sourceUid' => 5, 'messageId' => '<two@example.test>']
	],
	'wakeAt' => $now - 1,
	'createdAt' => $now,
	'updatedAt' => $now,
	'reminderStatus' => 'pending'
];
$store->insert($record);
$assert(1 === \count($store->all()), 'The account journal must persist one snooze.');
$otherStore = new \RainLoop\Snooze\Store(
	$storage,
	new \RainLoop\Model\Account('bob@example.test', 'different-secret')
);
$assert([] === $otherStore->all(), 'One account must never see another account\'s snoozes.');

$claimed = $store->claimDue($now);
$assert(1 === \count($claimed), 'A due active snooze must be claimed.');
$assert('restoring' === $claimed[0]['status'], 'A due claim must enter restoring state.');
$assert([] === $store->claimDue($now), 'A live claim must not be returned twice.');

$token = $claimed[0]['claimToken'];
$claimed[0]['status'] = 'restored';
$finished = $store->finish($claimed[0], $token);
$assert('restored' === $finished['status'], 'The current claim must finish successfully.');
$assert(null === $store->finish($claimed[0], $token), 'A consumed claim token must be idempotent.');
$updated = $store->update($record['id'], static function (array $current) : array {
	$current['reminderStatus'] = 'sent';
	return $current;
});
$assert('sent' === $updated['reminderStatus'], 'A terminal reminder result must persist without reopening a restore claim.');
$assert('restored' === $updated['status'], 'Saving a reminder result must not reopen terminal work.');

$journal = \file_get_contents($storage->GenerateFilePath($account, 1) . 'snooze-v1.json');
$backup = \file_get_contents($storage->GenerateFilePath($account, 1) . 'snooze-v1.backup.json');
$assert(!\str_contains($journal, 'must-not-be-stored'), 'The snooze journal must never contain mailbox credentials.');
$assert(!\str_contains($backup, 'must-not-be-stored'), 'The snooze backup must never contain mailbox credentials.');
$assert(\str_contains($journal, '<one@example.test>'), 'The journal must retain stable message identity.');
$storage->Put($account, 1, 'snooze-v1.json', '{broken');
$assert(1 === \count($store->all()), 'A torn journal write must recover from its last valid backup.');

\unlink($storage->GenerateFilePath($account, 1) . '.snooze.lock');
\unlink($storage->GenerateFilePath($account, 1) . 'snooze-v1.json');
\unlink($storage->GenerateFilePath($account, 1) . 'snooze-v1.backup.json');
\rmdir($storage->GenerateFilePath($account, 1));
$otherPath = $storage->GenerateFilePath(new \RainLoop\Model\Account('bob@example.test'), 1);
\unlink($otherPath . '.snooze.lock');
\rmdir($otherPath);
\rmdir($data);
echo "Snooze store tests passed\n";

}
