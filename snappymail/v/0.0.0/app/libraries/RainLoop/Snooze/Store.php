<?php

namespace RainLoop\Snooze;

use RainLoop\Model\Account;
use RainLoop\Providers\Storage;
use RainLoop\Providers\Storage\Enumerations\StorageType;

/**
 * Small account-scoped journal for IMAP snooze moves.
 *
 * Mailbox credentials deliberately never enter this store. The authenticated
 * account object is used only to select its existing private storage path.
 */
final class Store
{
	public const FOLDER = 'Snoozed';

	private const KEY = 'snooze-v1.json';
	private const BACKUP_KEY = 'snooze-v1.backup.json';
	private const MAX_ACTIVE = 250;
	private const HISTORY_TTL = 2592000;

	public function __construct(
		private Storage $storage,
		private Account $account
	) {
	}

	public function all() : array
	{
		return \array_values($this->readLocked()['records']);
	}

	public function get(string $id) : ?array
	{
		$records = $this->readLocked()['records'];
		return $records[$id] ?? null;
	}

	public function insert(array $record) : array
	{
		return $this->mutate(function (array &$records) use ($record) : array {
			$id = (string) ($record['id'] ?? '');
			if (!$id || isset($records[$id])) {
				throw new \RuntimeException('Snooze record already exists.');
			}

			$active = \array_filter($records, static fn(array $item) : bool =>
				!\in_array($item['status'] ?? '', ['restored', 'cancelled', 'failed'], true)
			);
			if (self::MAX_ACTIVE <= \count($active)) {
				throw new \RuntimeException('Too many active snoozes.');
			}

			$records[$id] = $record;
			return $record;
		});
	}

	/**
	 * Replace a claimed record only when the caller still owns its claim.
	 */
	public function finish(array $record, string $claimToken) : ?array
	{
		return $this->mutate(function (array &$records) use ($record, $claimToken) : ?array {
			$id = (string) ($record['id'] ?? '');
			$current = $records[$id] ?? null;
			if (!$current || !\hash_equals((string) ($current['claimToken'] ?? ''), $claimToken)) {
				return null;
			}

			$record['updatedAt'] = \time();
			unset($record['claimToken'], $record['claimedAt']);
			$records[$id] = $record;
			return $record;
		});
	}

	public function update(string $id, callable $callback) : ?array
	{
		return $this->mutate(function (array &$records) use ($id, $callback) : ?array {
			if (!isset($records[$id])) {
				return null;
			}
			$record = $callback($records[$id]);
			if (!\is_array($record)) {
				return $records[$id];
			}
			$record['updatedAt'] = \time();
			$records[$id] = $record;
			return $record;
		});
	}

	/**
	 * Claim one record for an immediate manual restore.
	 */
	public function claim(string $id, string $reason) : ?array
	{
		return $this->mutate(function (array &$records) use ($id, $reason) : ?array {
			$record = $records[$id] ?? null;
			if (!$record || \in_array($record['status'] ?? '', ['restored', 'cancelled', 'failed'], true)) {
				return $record;
			}
			if (isset($record['claimToken']) && (int) ($record['claimedAt'] ?? 0) + 120 > \time()) {
				return null;
			}

			$record['status'] = 'restoring';
			$record['restoreReason'] = $reason;
			$record['claimToken'] = \bin2hex(\random_bytes(16));
			$record['claimedAt'] = \time();
			$record['updatedAt'] = \time();
			$records[$id] = $record;
			return $record;
		});
	}

	/**
	 * Atomically claim due work. Stale claims are recoverable after two minutes.
	 */
	public function claimDue(int $now, int $limit = 20) : array
	{
		return $this->mutate(function (array &$records) use ($now, $limit) : array {
			$claimed = [];
			$ordered = $records;
			\uasort($ordered, static fn(array $a, array $b) : int =>
				((int) ($a['wakeAt'] ?? 0)) <=> ((int) ($b['wakeAt'] ?? 0))
			);

			foreach ($ordered as $id => $record) {
				if ($limit <= \count($claimed) || (int) ($record['wakeAt'] ?? 0) > $now) {
					continue;
				}
				$status = (string) ($record['status'] ?? '');
				$stale = (int) ($record['claimedAt'] ?? 0) + 120 <= $now;
				if ('active' !== $status && !(\in_array($status, ['moving', 'restoring'], true) && $stale)) {
					continue;
				}

				$record['status'] = 'restoring';
				$record['restoreReason'] = 'due';
				$record['claimToken'] = \bin2hex(\random_bytes(16));
				$record['claimedAt'] = $now;
				$record['updatedAt'] = $now;
				$records[$id] = $record;
				$claimed[] = $record;
			}
			return $claimed;
		});
	}

	private function read() : array
	{
		$raw = $this->storage->Get($this->account, StorageType::CONFIG, self::KEY, '');
		if (!\is_string($raw) || '' === $raw) {
			$backup = $this->storage->Get($this->account, StorageType::CONFIG, self::BACKUP_KEY, '');
			if (\is_string($backup) && '' !== $backup && ($data = $this->decode($backup))) {
				return $data;
			}
			return ['version' => 1, 'records' => []];
		}
		$data = $this->decode($raw);
		if (!$data) {
			$backup = $this->storage->Get($this->account, StorageType::CONFIG, self::BACKUP_KEY, '');
			$data = \is_string($backup) ? $this->decode($backup) : null;
		}
		if (!$data) {
			throw new \RuntimeException('Snooze storage is corrupt.');
		}
		return $data;
	}

	private function decode(string $raw) : ?array
	{
		try {
			$data = \json_decode($raw, true, 32, \JSON_THROW_ON_ERROR);
			return 1 === ($data['version'] ?? null) && \is_array($data['records'] ?? null)
				? $data
				: null;
		} catch (\Throwable $exception) {
			return null;
		}
	}

	private function readLocked() : array
	{
		$directory = $this->storage->GenerateFilePath($this->account, StorageType::CONFIG, true);
		if (!$directory) {
			throw new \RuntimeException('Account storage is unavailable.');
		}
		$lock = \fopen($directory . '.snooze.lock', 'c');
		if (!$lock || !\flock($lock, \LOCK_SH)) {
			throw new \RuntimeException('Could not lock snooze storage.');
		}
		try {
			return $this->read();
		} finally {
			\flock($lock, \LOCK_UN);
			\fclose($lock);
		}
	}

	private function mutate(callable $callback)
	{
		$directory = $this->storage->GenerateFilePath($this->account, StorageType::CONFIG, true);
		if (!$directory) {
			throw new \RuntimeException('Account storage is unavailable.');
		}

		$lock = \fopen($directory . '.snooze.lock', 'c');
		if (!$lock || !\flock($lock, \LOCK_EX)) {
			throw new \RuntimeException('Could not lock snooze storage.');
		}

		try {
			$data = $this->read();
			$records = $data['records'];
			$originalRecords = $records;
			$result = $callback($records);
			$this->prune($records);
			if ($records === $originalRecords) {
				return $result;
			}
			$previousJson = \json_encode($data, \JSON_UNESCAPED_SLASHES | \JSON_THROW_ON_ERROR);
			$data['records'] = $records;
			$json = \json_encode($data, \JSON_UNESCAPED_SLASHES | \JSON_THROW_ON_ERROR);
			if (!$this->storage->Put($this->account, StorageType::CONFIG, self::BACKUP_KEY, $previousJson)) {
				throw new \RuntimeException('Could not save snooze storage backup.');
			}
			if (!$this->storage->Put($this->account, StorageType::CONFIG, self::KEY, $json)) {
				throw new \RuntimeException('Could not save snooze storage.');
			}
			return $result;
		} finally {
			\flock($lock, \LOCK_UN);
			\fclose($lock);
		}
	}

	private function prune(array &$records) : void
	{
		$cutoff = \time() - self::HISTORY_TTL;
		foreach ($records as $id => $record) {
			if (\in_array($record['status'] ?? '', ['restored', 'cancelled', 'failed'], true)
				&& (int) ($record['updatedAt'] ?? 0) < $cutoff
			) {
				unset($records[$id]);
			}
		}
	}
}
