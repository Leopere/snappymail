<?php

namespace RainLoop\Actions;

use RainLoop\Enumerations\Capa;
use RainLoop\Exceptions\ClientException;

trait Contacts
{
	protected ?\RainLoop\Providers\AddressBook $oAddressBookProvider = null;

	public function AddressBookProvider(?\RainLoop\Model\Account $oAccount = null): \RainLoop\Providers\AddressBook
	{
		if (null === $this->oAddressBookProvider) {
			$oDriver = null;
			try {
//				if ($this->oConfig->Get('contacts', 'enable', false)) {
				if ($this->GetCapa(Capa::CONTACTS)) {
					$oDriver = $this->fabrica('address-book', $oAccount);
				}
			if ($oAccount && $oDriver) {
				$oDriver->SetEmail($this->GetMainEmail($oAccount));
				$aDavConfig = $this->getContactsSyncData($oAccount);
				if ($aDavConfig) {
					$aDavConfig['Timeout'] = 4;
					$aDavConfig['Deadline'] = 8;
				}
				$oDriver->setDAVClientConfig($aDavConfig);
			}
			} catch (\Throwable $e) {
				\SnappyMail\LOG::error('AddressBook', $e->getMessage()."\n".$e->getTraceAsString());
				$oDriver = null;
//				$oDriver = new \RainLoop\Providers\AddressBook\PdoAddressBook();
			}
			$this->oAddressBookProvider = new \RainLoop\Providers\AddressBook($oDriver);
			$this->oAddressBookProvider->SetLogger($this->oLogger);
		}

		return $this->oAddressBookProvider;
	}

	private function contactsSyncPublicData(?array $aData) : array
	{
		if (!$aData) {
			$aData = [
				'Mode' => 0,
				'Url' => '',
				'User' => '',
				'Auto' => true,
				'Disabled' => false
			];
		}

		$aData['Mode'] = (int) ($aData['Mode'] ?? 0);
		$aData['Url'] = (string) ($aData['Url'] ?? '');
		$aData['User'] = (string) ($aData['User'] ?? '');
		$aData['Auto'] = !empty($aData['Auto']);
		$aData['Disabled'] = !empty($aData['Disabled']);
		$aData['Password'] = empty($aData['Password']) ? '' : static::APP_DUMMY;
		$aData['Interval'] = \max(20, \min(320, (int) $this->Config()->Get('contacts', 'sync_interval', 20)));
		unset($aData['PasswordHMAC'], $aData['LastAttempt']);

		return $aData;
	}

	private function contactsSyncDiscoveryUrls(\RainLoop\Model\Account $oAccount) : array
	{
		$oDomain = $oAccount->Domain();
		$hosts = [
			$oDomain ? $oDomain->ImapSettings()->host : '',
			$oDomain ? $oDomain->SmtpSettings()->host : '',
			\ltrim(\strrchr($oAccount->Email(), '@') ?: '', '@')
		];
		$urls = [];
		foreach ($hosts as $host) {
			$host = \strtolower(\trim($host, " .\t\r\n"));
			if (!\preg_match('/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i', $host)) {
				continue;
			}
			$urls['https://' . $host . '/.well-known/carddav'] = true;
		}

		return \array_keys($urls);
	}

	/**
	 * Tries the mail domain's trusted DAV endpoints after login. The browser
	 * never receives or resubmits the account password for this discovery.
	 */
	public function DoDiscoverContactsSync() : array
	{
		if (!$this->GetCapa(Capa::CONTACTS) || !$this->Config()->Get('contacts', 'allow_sync', false)) {
			return $this->FalseResponse();
		}

		$oAccount = $this->getAccountFromToken();
		if (!$oAccount) {
			return $this->FalseResponse();
		}

		$aData = $this->getContactsSyncData($oAccount);
		if ($aData && ((empty($aData['Auto']) || !empty($aData['Disabled']))
			|| (!empty($aData['Mode']) && !empty($aData['Url'])))) {
			return $this->FalseResponse();
		}
		if (!empty($aData['LastAttempt']) && (int) $aData['LastAttempt'] + 900 > \time()) {
			return $this->FalseResponse();
		}

		// Mail-in-a-Box's DAV collections are named after the account address,
		// which can differ from an IMAP login alias.
		$sUser = $oAccount->Email() ?: $oAccount->ImapUser();
		$sPassword = $oAccount->ImapPass();
		if (!$sUser || !$sPassword) {
			return $this->FalseResponse();
		}

		foreach ($this->contactsSyncDiscoveryUrls($oAccount) as $sUrl) {
			$oDriver = $this->fabrica('address-book', $oAccount);
			if (!$oDriver) {
				break;
			}
			$oDriver->setDAVClientConfig([
				'Mode' => 2,
				'Auto' => true,
				'User' => $sUser,
					'Password' => $sPassword,
					'Url' => $sUrl,
					'Timeout' => 3,
					'Deadline' => 4
				]);

			try {
				$oClient = $oDriver->getDavClient();
			} catch (\Throwable $e) {
				$host = (string) \parse_url($sUrl, \PHP_URL_HOST);
				\SnappyMail\Log::warning('DAV', 'Automatic CardDAV discovery failed for '
					. ($host ?: 'unknown host') . ': ' . $e->getMessage());
				$oClient = null;
			}
			if ($oClient) {
				$aData = [
					'Mode' => 2,
					'Auto' => true,
					'Disabled' => false,
					'User' => $sUser,
					'Password' => $sPassword,
					'Url' => $oClient->currentUrl()
				];
				if ($this->setContactsSyncData($oAccount, $aData)) {
					return $this->DefaultResponse($this->contactsSyncPublicData($aData));
				}
				return $this->FalseResponse();
			}
		}

		$this->setContactsSyncData($oAccount, [
			'Mode' => 0,
			'Auto' => true,
			'Disabled' => false,
			'User' => '',
			'Password' => '',
			'Url' => '',
			'LastAttempt' => \time()
		]);

		return $this->FalseResponse();
	}

	public function DoSaveContactsSyncData() : array
	{
		$oAccount = $this->getAccountFromToken();

		$oAddressBookProvider = $this->AddressBookProvider($oAccount);
		if (!$oAddressBookProvider || !$oAddressBookProvider->IsActive()) {
			return $this->FalseResponse();
		}

		$sPassword = $this->GetActionParam('Password', '');

		$mData = $this->getContactsSyncData($oAccount);

		$iMode = \intval($this->GetActionParam('Mode', '0'));
		$bResult = $this->setContactsSyncData($oAccount, array(
			'Mode' => $iMode,
			'Auto' => false,
			'Disabled' => 0 === $iMode,
			'User' => $this->GetActionParam('User', ''),
			'Password' => static::APP_DUMMY === $sPassword
				? (isset($mData['Password']) ? $mData['Password'] : '')
				: $sPassword,
			'Url' => $this->GetActionParam('Url', '')
		));

		return $this->DefaultResponse($bResult);
	}

	public function DoTestContactsSyncData() : array
	{
		if (!$this->GetCapa(Capa::CONTACTS)) {
			throw new ClientException(\RainLoop\Notifications::ContactsSyncError, null, 'Disallowed');
		}

		$oAccount = $this->getAccountFromToken();

		$sPassword = $this->GetActionParam('Password', '');
		if (static::APP_DUMMY === $sPassword) {
			$mData = $this->getContactsSyncData($oAccount);
			$sPassword = isset($mData['Password']) ? $mData['Password'] : '';
		}
		$oDriver = $this->fabrica('address-book', $oAccount);
		if (!$oDriver) {
			throw new ClientException(\RainLoop\Notifications::ContactsSyncError, null, 'No driver');
		}
		$oDriver->SetEmail($this->GetMainEmail($oAccount));
		$oDriver->setDAVClientConfig([
			'Mode' => 2, // readonly
			'User' => $this->GetActionParam('User', ''),
			'Password' => $sPassword,
			'Url' => $this->GetActionParam('Url', ''),
			'Timeout' => 5
		]);

		$oClient = $oDriver->getDavClient();
		if (!$oClient) {
			throw new ClientException(\RainLoop\Notifications::ContactsSyncError, null, 'No client');
		}
		$oClient->propFind($oClient->urlPath, [
			'{DAV:}getlastmodified',
			'{DAV:}resourcetype',
			'{DAV:}getetag'
		], 1);

		return $this->TrueResponse();
	}

	public function DoContactsSync() : array
	{
		$oAccount = $this->getAccountFromToken();
		$oAddressBookProvider = $this->AddressBookProvider($oAccount);
		if (!$oAddressBookProvider) {
			throw new ClientException(\RainLoop\Notifications::ContactsSyncError, null, 'No AddressBookProvider');
		}
		\ignore_user_abort(true);
		\SnappyMail\HTTP\Stream::start(/*$binary = false*/);
		\SnappyMail\HTTP\Stream::JSON(['messsage'=>'start']);
		if (!$oAddressBookProvider->Sync()) {
			throw new ClientException(\RainLoop\Notifications::ContactsSyncError, null, 'AddressBookProvider->Sync() failed');
		}
		return $this->TrueResponse();
	}

	public function DoContacts() : array
	{
		$oAccount = $this->getAccountFromToken();

		$sSearch = \trim($this->GetActionParam('Search', ''));
		$iOffset = (int) $this->GetActionParam('Offset', 0);
		$iLimit = (int) $this->GetActionParam('Limit', 20);
		$iOffset = 0 > $iOffset ? 0 : $iOffset;
		$iLimit = 0 > $iLimit ? 20 : $iLimit;

		$iResultCount = 0;
		$mResult = array();

		$oAbp = $this->AddressBookProvider($oAccount);
		if ($oAbp->IsActive()) {
			$iResultCount = 0;
			$mResult = $oAbp->GetContacts($iOffset, $iLimit, $sSearch, $iResultCount);
		}

		return $this->DefaultResponse(array(
			'Offset' => $iOffset,
			'Limit' => $iLimit,
			'Count' => $iResultCount,
			'Search' => $sSearch,
			'List' => $mResult
		));
	}

	public function DoContactsDelete() : array
	{
		$oAccount = $this->getAccountFromToken();
		$aUids = \explode(',', (string) $this->GetActionParam('uids', ''));

		$aFilteredUids = \array_filter(\array_map('intval', $aUids));

		$bResult = false;
		if (\count($aFilteredUids) && $this->AddressBookProvider($oAccount)->IsActive()) {
			$bResult = $this->AddressBookProvider($oAccount)->DeleteContacts($aFilteredUids);
		}

		return $this->DefaultResponse($bResult);
	}

	public function DoContactSave() : array
	{
		$oAccount = $this->getAccountFromToken();

		$bResult = false;

		if ($this->HasActionParam('uid') && $this->HasActionParam('jCard')) {
			$oAddressBookProvider = $this->AddressBookProvider($oAccount);
			if ($oAddressBookProvider && $oAddressBookProvider->IsActive()) {
				$vCard = \Sabre\VObject\Reader::readJson($this->GetActionParam('jCard'));
				if ($vCard && $vCard instanceof \Sabre\VObject\Component\VCard) {
					$vCard->REV = \gmdate('Ymd\\THis\\Z');
					$vCard->PRODID = 'SnappyMail-'.APP_VERSION;
					$sUid = \trim($this->GetActionParam('uid'));
					$oContact = $sUid ? $oAddressBookProvider->GetContactByID($sUid) : null;
					if (!$oContact) {
						$oContact = new \RainLoop\Providers\AddressBook\Classes\Contact();
					}
					$oContact->setVCard($vCard);
					$bResult = $oAddressBookProvider->ContactSave($oContact);
				}
			}
		}

		return $this->DefaultResponse(array(
			'ResultID' => $bResult ? $oContact->id : '',
			'Result' => $bResult
		));
	}

	public function UploadContacts(?array $aFile, int $iError) : array
	{
		$oAccount = $this->getAccountFromToken();

		$mResponse = false;

		if ($oAccount && UPLOAD_ERR_OK === $iError && \is_array($aFile)) {
			$sSavedName = 'upload-post-'.\md5($aFile['name'].$aFile['tmp_name']);
			if (!$this->FilesProvider()->MoveUploadedFile($oAccount, $sSavedName, $aFile['tmp_name'])) {
				$iError = \RainLoop\Enumerations\UploadError::ON_SAVING;
			} else {
				\ini_set('auto_detect_line_endings', '1');
				$mData = $this->FilesProvider()->GetFile($oAccount, $sSavedName);
				if ($mData) {
					$sFileStart = \fread($mData, 128);
					\rewind($mData);
					if (false !== $sFileStart) {
						$sFileStart = \trim($sFileStart);
						if (false !== \strpos($sFileStart, 'BEGIN:VCARD')) {
							$mResponse = $this->importContactsFromVcfFile($oAccount, $mData);
						} else if (false !== \strpos($sFileStart, ',') || false !== \strpos($sFileStart, ';')) {
							$mResponse = $this->importContactsFromCsvFile($oAccount, $mData, $sFileStart);
						}
					}
				}

				if (\is_resource($mData)) {
					\fclose($mData);
				}

				unset($mData);
				$this->FilesProvider()->Clear($oAccount, $sSavedName);

				\ini_set('auto_detect_line_endings', '0');
			}
		}

		if (UPLOAD_ERR_OK !== $iError) {
			$iClientError = 0;
			$sError = \RainLoop\Enumerations\UploadError::getUserMessage($iError, $iClientError);
			if (!empty($sError)) {
				return $this->FalseResponse($iClientError, $sError);
			}
		}

		return $this->DefaultResponse($mResponse);
	}

	public function setContactsSyncData(\RainLoop\Model\Account $oAccount, array $aData) : bool
	{
		if (!isset($aData['Mode'])) {
			$aData['Mode'] = empty($aData['Enable']) ? 0 : 1;
		}
//		$oAccount = $this->getAccountFromToken();
		$aData['Mode'] = (int) $aData['Mode'];
		$aData['Auto'] = !empty($aData['Auto']);
		$aData['Disabled'] = !empty($aData['Disabled']);
		$aData['Password'] = (string) ($aData['Password'] ?? '');
		$oMainAccount = $this->getMainAccountFromToken();
		if ($aData['Password']) {
			$aData['Password'] = \SnappyMail\Crypt::EncryptToJSON($aData['Password'], $oMainAccount->CryptKey());
		}
		$aData['PasswordHMAC'] = $aData['Password'] ? \hash_hmac('sha1', $aData['Password'], $oMainAccount->CryptKey()) : null;
		return $this->StorageProvider()->Put(
			$oAccount,
			\RainLoop\Providers\Storage\Enumerations\StorageType::CONFIG,
			'contacts_sync',
			\json_encode($aData)
		);
	}

	protected function getContactsSyncData(\RainLoop\Model\Account $oAccount) : ?array
	{
//		$oAccount = $this->getAccountFromToken();
		$sData = $this->StorageProvider()->Get($oAccount,
			\RainLoop\Providers\Storage\Enumerations\StorageType::CONFIG,
			'contacts_sync'
		);
		if (!empty($sData)) {
			$aData = \json_decode($sData, true);
			if ($aData) {
				if (!empty($aData['Password'])) {
					$oMainAccount = $this->getMainAccountFromToken();
					// Verify oAccount password hasn't changed so that Password can be decrypted
					if (empty($aData['PasswordHMAC']) || !\hash_equals(
						$aData['PasswordHMAC'], \hash_hmac('sha1', $aData['Password'], $oMainAccount->CryptKey())
					)) {
						// Failed
						$aData['Password'] = null;
					} else {
						// Success
						$aData['Password'] = \SnappyMail\Crypt::DecryptFromJSON(
							$aData['Password'],
							$oMainAccount->CryptKey()
						);
					}
				}
				if (!isset($aData['Mode'])) {
					$aData['Mode'] = empty($aData['Enable']) ? 0 : 1;
				}
				$aData['Auto'] = !empty($aData['Auto']);
				$aData['Disabled'] = !empty($aData['Disabled']);
				return $aData;
			}

			return \SnappyMail\Upgrade::ConvertInsecureContactsSync($this, $oAccount);
		}
		return null;
	}

	public function RawContactsVcf() : bool
	{
		$oAccount = $this->getAccountFromToken();

		\header('Content-Type: text/x-vcard; charset=UTF-8');
		\header('Content-Disposition: attachment; filename="contacts.vcf"');
		\header('Accept-Ranges: none');
		\header('Content-Transfer-Encoding: binary');

		$this->Http()->ServerNoCache();

		$oAddressBookProvider = $this->AddressBookProvider($oAccount);
		return $oAddressBookProvider->IsActive() ?
			$oAddressBookProvider->Export('vcf') : false;
	}

	public function RawContactsCsv() : bool
	{
		$oAccount = $this->getAccountFromToken();

		\header('Content-Type: text/csv; charset=UTF-8');
		\header('Content-Disposition: attachment; filename="contacts.csv"');
		\header('Accept-Ranges: none');
		\header('Content-Transfer-Encoding: binary');

		$this->Http()->ServerNoCache();

		$oAddressBookProvider = $this->AddressBookProvider($oAccount);
		return $oAddressBookProvider->IsActive() ?
			$oAddressBookProvider->Export('csv') : false;
	}

	private function importContactsFromVcfFile(\RainLoop\Model\Account $oAccount, /*resource*/ $rFile): int
	{
		$iCount = 0;
		$oAddressBookProvider = $this->AddressBookProvider($oAccount);
		if (\is_resource($rFile) && $oAddressBookProvider && $oAddressBookProvider->IsActive()) {
			try
			{
				$this->logWrite('Import contacts from vcf');
				foreach (\RainLoop\Providers\AddressBook\Utils::VcfStreamToContacts($rFile) as $oContact) {
					if ($oAddressBookProvider->ContactSave($oContact)) {
						++$iCount;
					}
				}
			}
			catch (\Throwable $oExc)
			{
				$this->logException($oExc);
			}
		}
		return $iCount;
	}

	private function importContactsFromCsvFile(\RainLoop\Model\Account $oAccount, /*resource*/ $rFile, string $sFileStart): int
	{
		$iCount = 0;
		$oAddressBookProvider = $this->AddressBookProvider($oAccount);
		if (\is_resource($rFile) && $oAddressBookProvider && $oAddressBookProvider->IsActive()) {
			try
			{
				$this->logWrite('Import contacts from csv');
				$sDelimiter = ((int)\strpos($sFileStart, ',') > (int)\strpos($sFileStart, ';')) ? ',' : ';';
				foreach (\RainLoop\Providers\AddressBook\Utils::CsvStreamToContacts($rFile, $sDelimiter) as $oContact) {
					if ($oAddressBookProvider->ContactSave($oContact)) {
						++$iCount;
					}
				}
			}
			catch (\Throwable $oExc)
			{
				$this->logException($oExc);
			}
		}
		return $iCount;
	}

}
