<?php

namespace RainLoop;

class ServiceActions
{
	protected \MailSo\Base\Http $oHttp;

	protected Actions $oActions;

	protected array $aPaths = array();

	protected string $sQuery = '';

	public function __construct(\MailSo\Base\Http $oHttp, Actions $oActions)
	{
		$this->oHttp = $oHttp;
		$this->oActions = $oActions;
	}

	private function Logger() : \MailSo\Log\Logger
	{
		return $this->oActions->Logger();
	}

	private function Plugins() : Plugins\Manager
	{
		return $this->oActions->Plugins();
	}

	private function Config() : Config\Application
	{
		return $this->oActions->Config();
	}

	private function Cacher() : \MailSo\Cache\CacheClient
	{
		return $this->oActions->Cacher();
	}

	private function StorageProvider() : Providers\Storage
	{
		return $this->oActions->StorageProvider();
	}

	private function SettingsProvider() : Providers\Settings
	{
		return $this->oActions->SettingsProvider();
	}

	private static function actionLogKeyIsSensitive(string $key) : bool
	{
		$key = \strtolower(\preg_replace('/[^a-z0-9]/i', '', $key));
		return \str_contains($key, 'pass')
			|| \str_contains($key, 'secret')
			|| \str_contains($key, 'token')
			|| \str_contains($key, 'apikey')
			|| \str_contains($key, 'privatekey')
			|| \str_contains($key, 'authorization')
			|| \str_contains($key, 'credential');
	}

	private static function actionLogKeyIsPrivateForMethod(string $key, string $method) : bool
	{
		$key = \strtolower(\preg_replace('/[^a-z0-9]/i', '', $key));
		if (\str_starts_with($method, 'DoPluginRockSign')) {
			return !\in_array($key, ['action', 'xtoken', 'templateid', 'delivery', 'submissionid', 'filekey'], true);
		}
		if (\in_array($method, ['DoSendMessage', 'DoSaveMessage'], true)) {
			return !\in_array($key, [
				'action', 'xtoken', 'identityid', 'messagefolder', 'messageuid', 'savefolder',
				'markasimportant', 'dsn', 'requiretls', 'readreceiptrequest'
			], true);
		}
		return false;
	}

	private static function maskActionLogValue($value, callable $mask) : void
	{
		if (\is_array($value)) {
			foreach ($value as $item) {
				static::maskActionLogValue($item, $mask);
			}
		} else if (\is_scalar($value) && \strlen((string) $value)) {
			$mask((string) $value);
		}
	}

	private static function redactActionLogParams(array $params, callable $mask, string $method = '') : array
	{
		foreach ($params as $key => $value) {
			if (static::actionLogKeyIsSensitive((string) $key)
				|| static::actionLogKeyIsPrivateForMethod((string) $key, $method)) {
				static::maskActionLogValue($value, $mask);
				$params[$key] = '*******';
			} else if (\is_array($value)) {
				$params[$key] = static::redactActionLogParams($value, $mask, $method);
			}
		}
		return $params;
	}

	public function SetPaths(array $aPaths) : self
	{
		$this->aPaths = $aPaths;
		return $this;
	}

	public function SetQuery(string $sQuery) : self
	{
		$this->sQuery = $sQuery;
		return $this;
	}

	public function ServiceManifest() : string
	{
		\header('Content-Type: application/manifest+json; charset=utf-8');
		return Utils::jsonEncode(\SnappyMail\Branding::manifest());
	}

	private function wellKnownHostAllowsDomain(string $host, string $domain) : bool
	{
		$host = \SnappyMail\PGP\Wkd::normalizeHost($host);
		$domain = \SnappyMail\PGP\Wkd::normalizeDomain($domain);
		return $host && $domain && ($host === $domain || \str_ends_with($host, '.' . $domain));
	}

	private function wellKnownHostMatchesWkd(string $host, string $domain, bool $advanced) : bool
	{
		$host = \SnappyMail\PGP\Wkd::normalizeHost($host);
		$domain = \SnappyMail\PGP\Wkd::normalizeDomain($domain);
		return $host && $domain && ($advanced ? $host === 'openpgpkey.' . $domain : $host === $domain);
	}

	private function wellKnownNotFound() : string
	{
		\MailSo\Base\Http::StatusHeader(404);
		\header('Content-Type: text/plain; charset=utf-8');
		\header('Content-Length: 0');
		return '';
	}

	private function wellKnownNoStoreHeaders() : void
	{
		\header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
		\header('Pragma: no-cache');
		\header('Expires: 0');
	}

	public function ServiceWellKnown() : string
	{
		if ('openpgpkey' !== ($this->aPaths[1] ?? '')) {
			return $this->wellKnownNotFound();
		}

		$method = $this->oHttp->GetMethod();
		if (!\in_array($method, ['GET', 'HEAD'], true)) {
			\MailSo\Base\Http::StatusHeader(405);
			return '';
		}

		$paths = \array_values($this->aPaths);
		if ((3 === \count($paths) && 'policy' === ($paths[2] ?? ''))
			|| (4 === \count($paths) && !empty($paths[2]) && 'policy' === ($paths[3] ?? ''))) {
			if (4 === \count($paths)
				&& !$this->wellKnownHostMatchesWkd($this->oHttp->GetHost(false, true), $paths[2], true)) {
				return $this->wellKnownNotFound();
			}
			\header('Content-Type: text/plain; charset=utf-8');
			\header('Content-Length: 0');
			return 'HEAD' === $method ? '' : '';
		}

		if ((3 === \count($paths) && 'index.json' === ($paths[2] ?? ''))
			|| (4 === \count($paths) && !empty($paths[2]) && 'index.json' === ($paths[3] ?? ''))) {
			$host = $this->oHttp->GetHost(false, true);
			$domain = 4 === \count($paths) ? (string) $paths[2] : $host;
			if (!$this->wellKnownHostAllowsDomain($host, $domain)) {
				return $this->wellKnownNotFound();
			}

			$advanced = 4 === \count($paths);
			$domain = \SnappyMail\PGP\Wkd::normalizeDomain($domain);
			$host = \SnappyMail\PGP\Wkd::normalizeHost($host);
			if (!$advanced && $host === $domain) {
				$baseUrl = "https://{$domain}/.well-known/openpgpkey";
			} else {
				$baseUrl = "https://openpgpkey.{$domain}/.well-known/openpgpkey/{$domain}";
			}
			$json = Utils::jsonEncode(\SnappyMail\PGP\Wkd::manifest($domain, $baseUrl));
			$this->wellKnownNoStoreHeaders();
			\header('Content-Type: application/json; charset=utf-8');
			\header('Content-Length: ' . \strlen($json));
			return 'HEAD' === $method ? '' : $json;
		}

		$domain = '';
		$hash = '';
		if (4 === \count($paths) && 'hu' === ($paths[2] ?? '') && !empty($paths[3])) {
			$domain = $this->oHttp->GetHost(false, true);
			$hash = $paths[3];
		} else if (5 === \count($paths) && !empty($paths[2]) && 'hu' === ($paths[3] ?? '') && !empty($paths[4])) {
			$domain = $paths[2];
			$hash = $paths[4];
		}

		$host = $this->oHttp->GetHost(false, true);
		$advanced = 5 === \count($paths);
		if ($domain && !$this->wellKnownHostMatchesWkd($host, $domain, $advanced)) {
			return $this->wellKnownNotFound();
		}

		$key = $domain && $hash
			? \SnappyMail\PGP\Wkd::read($domain, $hash, $_GET['l'] ?? '')
			: '';
		if (!$key) {
			return $this->wellKnownNotFound();
		}

		\MailSo\Base\Http::setETag('wkd-' . \sha1($domain . '/' . $hash . '/' . $key));
		$this->wellKnownNoStoreHeaders();
		\header('Content-Type: application/octet-stream');
		\header('Content-Length: ' . \strlen($key));
		return 'HEAD' === $method ? '' : $key;
	}

/*
	public function ServiceBackup() : void
	{
		if (\method_exists($this->oActions, 'DoAdminBackup')) {
			$this->oActions->DoAdminBackup();
		}
		exit;
	}
*/

	public function ServiceJson() : string
	{
		\ob_start();
		$requestStartedAt = \microtime(true);

		$aResponse = null;
		$oException = null;

		if (empty($_POST) || (!empty($_SERVER['CONTENT_TYPE']) && \str_contains($_SERVER['CONTENT_TYPE'], 'application/json'))) {
			$_POST = \json_decode(\file_get_contents('php://input'), true);
		}

		$sAction = $_POST['Action'] ?? '';
		if (empty($sAction) && $this->oHttp->IsGet() && !empty($this->aPaths[2])) {
			$sAction = $this->aPaths[2];
		}

		$this->oActions->SetIsJson(true);

		try
		{
			if (empty($sAction)) {
				throw new Exceptions\ClientException(Notifications::InvalidInputArgument, null, 'Action unknown');
			}

			if ('Logout' !== $sAction) {
				$token = Utils::GetCsrfToken();
				if (isset($_SERVER['HTTP_X_SM_TOKEN'])) {
					if ($_SERVER['HTTP_X_SM_TOKEN'] !== $token) {
						$oAccount = $this->oActions->getAccountFromToken(false);
						$sEmail = $oAccount ? $oAccount->Email() : 'guest';
						$this->oActions->logWrite("HTTP token mismatch for {$sEmail}", \LOG_ERR, 'Token');
						throw new Exceptions\ClientException(Notifications::InvalidToken, null, 'HTTP Token mismatch');
					}
				} else if ($this->oHttp->IsPost()) {
					if (empty($_POST['XToken']) || $_POST['XToken'] !== $token) {
						$oAccount = $this->oActions->getAccountFromToken(false);
						$sEmail = $oAccount ? $oAccount->Email() : 'guest';
						$this->oActions->logWrite("XToken mismatch for {$sEmail}", \LOG_ERR, 'XToken');
						throw new Exceptions\ClientException(Notifications::InvalidToken, null, 'XToken mismatch');
					}
				}
			}

			if ($this->oActions instanceof ActionsAdmin && 0 === \stripos($sAction, 'Admin') && !\in_array($sAction, ['AdminLogin', 'AdminLogout'])) {
				$this->oActions->IsAdminLoggined();
			}

			$sMethodName = 'Do'.$sAction;

			$this->oActions->logWrite('Action: '.$sMethodName, \LOG_INFO, 'JSON');

			if ($_POST) {
				$this->oActions->SetActionParams($_POST, $sMethodName);
				$aPost = static::redactActionLogParams($_POST, function (string $secret) : void {
					$this->oActions->logMask($secret);
				}, $sMethodName);
				$this->oActions->logWrite(Utils::jsonEncode($aPost), \LOG_INFO, 'POST');
			} else if (3 < \count($this->aPaths) && $this->oHttp->IsGet()) {
				$this->oActions->SetActionParams(array(
					'RawKey' => empty($this->aPaths[3]) ? '' : $this->aPaths[3]
				), $sMethodName);
			}

			if (\method_exists($this->oActions, $sMethodName) && \is_callable(array($this->oActions, $sMethodName))) {
				$this->Plugins()->RunHook("json.before-{$sAction}");
				$aResponse = $this->oActions->{$sMethodName}();
			} else if ($this->Plugins()->HasAdditionalJson($sMethodName)) {
				$this->Plugins()->RunHook("json.before-{$sAction}");
				$aResponse = $this->Plugins()->RunAdditionalJson($sMethodName);
			}

			if (\is_array($aResponse)) {
				// Everything must converted to array
				$aResponse = \json_decode(Utils::jsonEncode($aResponse), true);
				$this->Plugins()->RunHook("json.after-{$sAction}", array(&$aResponse));
			}

			if (!\is_array($aResponse)) {
				throw new Exceptions\ClientException(Notifications::UnknownError);
			}
		}
		catch (\Throwable $oException)
		{
			\SnappyMail\Log::warning('SERVICE', "{$oException}");
			if ($e = $oException->getPrevious()) {
				\SnappyMail\Log::warning('SERVICE', "- {$e}");
			}

			$aResponse = $this->oActions->ExceptionResponse($oException);
		}

		$durationMs = (int) \round(1000 * (\microtime(true) - $requestStartedAt));
		if (!\headers_sent()) {
			\header('Server-Timing: snappymail;dur=' . $durationMs);
		}
		if (1000 <= $durationMs) {
			$action = \preg_replace('/[^A-Za-z0-9._-]/', '?', (string) $sAction);
			\SnappyMail\Log::warning('PERF', "json action={$action} result=" . ($oException ? 'error' : 'ok') . " total={$durationMs}ms");
		}

		$aResponse['Action'] = $sAction ?: 'Unknown';

		if (!\headers_sent()) {
			\header('Content-Type: application/json; charset=utf-8');
		}

		if (\is_array($aResponse)) {
			$aResponse['epoch'] = \time();
//			if ($this->Config()->Get('debug', 'enable', false)) {
//				$aResponse['rtime'] = \round(\microtime(true) - $_SERVER['REQUEST_TIME_FLOAT'], 3);
//			}
		}

		$sResult = Utils::jsonEncode($aResponse);

		$sObResult = \ob_get_clean();

		if ($this->Logger()->IsEnabled()) {
			if (\strlen($sObResult)) {
				$this->oActions->logWrite($sObResult, \LOG_ERR, 'OB-DATA');
			}

			if ($oException) {
				$this->oActions->logException($oException, \LOG_ERR);
			}

			$iLimit = (int) $this->Config()->Get('logs', 'json_response_write_limit', 0);
			$this->oActions->logWrite(0 < $iLimit && $iLimit < \strlen($sResult)
					? \substr($sResult, 0, $iLimit).'...' : $sResult, \LOG_INFO, 'JSON');
		}

		return $sResult;
	}

	private function privateUpload(string $sAction, int $iSizeLimit = 0) : string
	{
		$oConfig = $this->Config();

		\ob_start();
		$aResponse = null;
		try
		{
			$aFile = null;
			$sInputName = 'uploader';
			$iSizeLimit = (0 < $iSizeLimit ? $iSizeLimit : ((int) $oConfig->Get('webmail', 'attachment_size_limit', 0))) * 1024 * 1024;

			$_FILES = isset($_FILES) ? $_FILES : null;
			if (isset($_FILES[$sInputName], $_FILES[$sInputName]['name'], $_FILES[$sInputName]['tmp_name'], $_FILES[$sInputName]['size'])) {
				$iError = (isset($_FILES[$sInputName]['error'])) ? (int) $_FILES[$sInputName]['error'] : UPLOAD_ERR_OK;
//				\is_uploaded_file($_FILES[$sInputName]['tmp_name'])

				if (UPLOAD_ERR_OK === $iError && 0 < $iSizeLimit && $iSizeLimit < (int) $_FILES[$sInputName]['size']) {
					$iError = Enumerations\UploadError::CONFIG_SIZE;
				}

				if (UPLOAD_ERR_OK === $iError) {
					$aFile = $_FILES[$sInputName];
				}
			} else if (empty($_FILES)) {
				$iError = UPLOAD_ERR_INI_SIZE;
			} else {
				$iError = Enumerations\UploadError::EMPTY_FILE;
			}

			if (\method_exists($this->oActions, $sAction) && \is_callable(array($this->oActions, $sAction))) {
				$aResponse = $this->oActions->{$sAction}($aFile, $iError);
			}

			if (!is_array($aResponse)) {
				throw new Exceptions\ClientException(Notifications::UnknownError);
			}

			$this->Plugins()->RunHook('filter.upload-response', array(&$aResponse));
		}
		catch (\Throwable $oException)
		{
			$aResponse = $this->oActions->ExceptionResponse($oException);
		}

		$aResponse['Action'] = $sAction ?: 'Unknown';

		\header('Content-Type: application/json; charset=utf-8');

		$sResult = Utils::jsonEncode($aResponse);

		$sObResult = \ob_get_clean();
		if (\strlen($sObResult)) {
			$this->oActions->logWrite($sObResult, \LOG_ERR, 'OB-DATA');
		}

		$this->oActions->logWrite($sResult, \LOG_INFO, 'UPLOAD');

		return $sResult;
	}

	public function ServiceUpload() : string
	{
		return $this->privateUpload('Upload');
	}

	public function ServiceUploadContacts() : string
	{
		return $this->privateUpload('UploadContacts', 5);
	}

	public function ServiceUploadBackground() : string
	{
		return $this->privateUpload('UploadBackground', 1);
	}

	public function ServiceProxyExternal() : string
	{
		$sData = empty($this->aPaths[1]) ? '' : $this->aPaths[1];
		if ($sData
		  && $this->Config()->Get('labs', 'use_local_proxy_for_external_images', false)
		  && $this->oActions->getAccountFromToken()
		) {
			$this->oActions->verifyCacheByKey($sData);
			$sUrl = \MailSo\Base\Utils::UrlSafeBase64Decode($sData);
			if (!empty($sUrl)) {
				\header('X-Content-Location: '.$sUrl);
				$tmp = \tmpfile();
				$HTTP = \SnappyMail\HTTP\Request::factory();
				$HTTP->max_redirects = 2;
				$HTTP->streamBodyTo($tmp);
				$oResponse = $HTTP->doRequest('GET', $sUrl);
				if ($oResponse) {
					$sContentType = \SnappyMail\File\MimeType::fromStream($tmp) ?: $oResponse->getHeader('content-type');
					if (200 === $oResponse->status && \str_starts_with($sContentType, 'image/')) {
						try {
							$this->oActions->cacheByKey($sData);
							\header('Content-Type: ' . $sContentType);
							\header('Cache-Control: public');
							\header('Expires: '.\gmdate('D, j M Y H:i:s', 2592000 + \time()).' UTC');
							\header('X-Content-Redirect-Location: '.$oResponse->final_uri);
							\rewind($tmp);
							\fpassthru($tmp);
							exit;
						} catch (\Throwable $e) {
							\header("X-Content-Error: {$e->getMessage()}");
							\SnappyMail\Log::error('Proxy', \get_class($HTTP) . ': ' . $e->getMessage());
						}
					} else {
						\header("X-Content-Error: {$oResponse->status} {$sContentType}");
					}
				}
			}
		}

		\MailSo\Base\Http::StatusHeader(404);
		return '';
	}

	public function ServiceCspReport() : void
	{
		\SnappyMail\HTTP\CSP::logReport();
	}

	public function ServiceRaw() : string
	{
		$sResult = '';
		$sRawError = '';
		$sAction = empty($this->aPaths[2]) ? '' : $this->aPaths[2];
		$oException = null;

		try
		{
			$sRawError = 'Invalid action';
			if (\strlen($sAction)) {
				try {
					$sMethodName = 'Raw'.$sAction;
					if (\method_exists($this->oActions, $sMethodName)) {
						\header('X-Raw-Action: '.$sMethodName);
						\header('Content-Security-Policy: script-src \'none\'; child-src \'none\'');

						$sRawError = '';
						$this->oActions->SetActionParams(array(
							'RawKey' => empty($this->aPaths[3]) ? '' : $this->aPaths[3],
							'Params' => $this->aPaths
						), $sMethodName);

						if (!$this->oActions->{$sMethodName}()) {
							$sRawError = 'False result';
						}
					} else {
						$sRawError = 'Unknown action "'.$sAction.'"';
					}
				} catch (\Throwable $e) {
//					error_log(print_r($e,1));
					$sRawError = $e->getMessage();
				}
			} else {
				$sRawError = 'Empty action';
			}
		}
		catch (Exceptions\ClientException $oException)
		{
			$sRawError = Notifications::AuthError == $oException->getCode()
				? 'Authentication failed'
				: 'Exception as result';
		}
		catch (\Throwable $oException)
		{
			$sRawError = 'Exception as result';
		}

		if (\strlen($sRawError)) {
			$this->oActions->logWrite($sRawError, \LOG_ERR);
			$this->Logger()->WriteDump($this->aPaths, \LOG_ERR, 'PATHS');
		}

		if ($oException) {
			$this->oActions->logException($oException, \LOG_ERR, 'RAW');
		}

		return $sResult;
	}

	public function ServiceLang() : string
	{
		$sResult = '';
		\header('Content-Type: application/javascript; charset=utf-8');

		if (!empty($this->aPaths[3])) {
			$bAdmin = 'Admin' === (isset($this->aPaths[2]) ? (string) $this->aPaths[2] : 'App');
			$sLanguage = $this->oActions->ValidateLanguage($this->aPaths[3], '', $bAdmin);

			$bCacheEnabled = $this->Config()->Get('cache', 'system_data', true);
			$sCacheFileName = '';
			if ($bCacheEnabled) {
				$sCacheFileName = KeyPathHelper::LangCache($sLanguage, $bAdmin, $this->oActions->Plugins()->Hash());
				$this->oActions->verifyCacheByKey(\md5($sCacheFileName));
				$sResult = $this->Cacher()->Get($sCacheFileName);
			}

			if (!$sResult) {
				$sResult = $this->oActions->compileLanguage($sLanguage, $bAdmin);
				if ($sCacheFileName) {
					$this->Cacher()->Set($sCacheFileName, $sResult);
				}
			}

			if ($sCacheFileName) {
				$this->oActions->cacheByKey(\md5($sCacheFileName));
			}
		}

		return $sResult;
	}

	public function ServicePlugins() : string
	{
		$sResult = '';
		$bAdmin = !empty($this->aPaths[2]) && 'Admin' === $this->aPaths[2];

		\header('Content-Type: application/javascript; charset=utf-8');

		$bAppDebug = $this->Config()->Get('debug', 'enable', false);
		$sMinify = ($bAppDebug || $this->Config()->Get('debug', 'javascript', false)) ? '' : 'min';

		$bCacheEnabled = !$bAppDebug && $this->Config()->Get('cache', 'system_data', true);
		$sCacheFileName = '';
		if ($bCacheEnabled) {
			$sCacheFileName = KeyPathHelper::PluginsJsCache($this->oActions->Plugins()->Hash()) . $sMinify;
			$this->oActions->verifyCacheByKey(\md5($sCacheFileName));
			$sResult = $this->Cacher()->Get($sCacheFileName);
		}

		if (!$sResult) {
			$sResult = $this->Plugins()->CompileJs($bAdmin, !!$sMinify);
			if ($sCacheFileName) {
				$this->Cacher()->Set($sCacheFileName, $sResult);
			}
		}

		if ($sCacheFileName) {
			$this->oActions->cacheByKey(\md5($sCacheFileName));
		}

		return $sResult;
	}

	public function ServiceCss() : string
	{
		$sResult = '';
		$bAdmin = !empty($this->aPaths[2]) && 'Admin' === $this->aPaths[2];
		$bJson = !empty($this->aPaths[9]) && 'Json' === $this->aPaths[9];

		if ($bJson) {
			\header('Content-Type: application/json; charset=utf-8');
		} else {
			\header('Content-Type: text/css; charset=utf-8');
		}

		$sTheme = '';
		if (!empty($this->aPaths[4])) {
			$sTheme = $this->oActions->ValidateTheme($this->aPaths[4]);

			$bAppDebug = $this->Config()->Get('debug', 'enable', false);
			$sMinify = ($bAppDebug || $this->Config()->Get('debug', 'css', false)) ? '' : 'min';

			$bCacheEnabled = !$bAppDebug && $this->Config()->Get('cache', 'system_data', true);
			$sCacheFileName = '';
			if ($bCacheEnabled) {
				$sCacheFileName = '/CssCache/'.$this->oActions->Plugins()->Hash().'/'.$sTheme.'/'.APP_VERSION.'/' . $sMinify;
				$this->oActions->verifyCacheByKey(\md5($sCacheFileName . ($bJson ? 1 : 0)));
				$sResult = $this->Cacher()->Get($sCacheFileName);
			}

			if (!$sResult) {
				try
				{
					$sResult = $this->oActions->compileCss($sTheme, $bAdmin);
					if ($sCacheFileName) {
						$this->Cacher()->Set($sCacheFileName, $sResult);
					}
				}
				catch (\Throwable $oException)
				{
					$this->oActions->logException($oException, \LOG_ERR, 'LESS');
				}
			}

			if ($sCacheFileName) {
				$this->oActions->cacheByKey(\md5($sCacheFileName . ($bJson ? 1 : 0 )));
			}
		}

		return $bJson ? Utils::jsonEncode(array($sTheme, $sResult)) : $sResult;
	}

	public function ServiceAppData() : string
	{
		return $this->localAppData(false);
	}

	public function ServiceAdminAppData() : string
	{
		return $this->localAppData(true);
	}

	public function ServiceMailto() : string
	{
		$this->oHttp->ServerNoCache();
		$sTo = \trim($_GET['to'] ?? '');
		if (\preg_match('/^mailto:/i', $sTo)) {
			\SnappyMail\Cookies::set(
				Actions::AUTH_MAILTO_TOKEN_KEY,
				Utils::EncodeKeyValuesQ(array(
					'Time' => \microtime(true),
					'MailTo' => 'MailTo',
					'To' => $sTo
				))
			);
		}
		\MailSo\Base\Http::Location('./');
		return '';
	}

	public function ServicePing() : string
	{
		$this->oHttp->ServerNoCache();

		\header('Content-Type: text/plain; charset=utf-8');
		$this->oActions->logWrite('Pong', \LOG_INFO, 'PING');
		return 'Pong';
	}

	public function ServiceTest() : string
	{
		$this->oHttp->ServerNoCache();
		\SnappyMail\Integrity::test();
		return '';
	}

	/**
	 * Login with the \RainLoop\API::CreateUserSsoHash() generated hash
	 */
	public function ServiceSso() : string
	{
		$this->oHttp->ServerNoCache();

		$oException = null;
		$oAccount = null;

		$sSsoHash = $_REQUEST['hash'] ?? '';
		if (!empty($sSsoHash)) {
			$mData = null;

			$sSsoSubData = $this->Cacher()->Get(KeyPathHelper::SsoCacherKey($sSsoHash));
			if (!empty($sSsoSubData)) {
				$aData = \SnappyMail\Crypt::DecryptFromJSON($sSsoSubData, $sSsoHash);

				$this->Cacher()->Delete(KeyPathHelper::SsoCacherKey($sSsoHash));

				if (\is_array($aData) && !empty($aData['Email']) && isset($aData['Password'], $aData['Time']) &&
					(0 === $aData['Time'] || \time() - 10 < $aData['Time']))
				{
					$aAdditionalOptions = (isset($aData['AdditionalOptions']) && \is_array($aData['AdditionalOptions']))
						? $aData['AdditionalOptions'] : [];
					try
					{
						$oAccount = $this->oActions->LoginProcess(
							\trim($aData['Email']),
							new \SnappyMail\SensitiveString($aData['Password'])
						);
						if ($aAdditionalOptions) {
							$bSaveSettings = false;

							$oSettings = $this->SettingsProvider()->Load($oAccount);
							if ($oSettings) {
								$sLanguage = isset($aAdditionalOptions['language']) ?
									$aAdditionalOptions['language'] : '';

								if ($sLanguage) {
									$sLanguage = $this->oActions->ValidateLanguage($sLanguage);
									if ($sLanguage !== $oSettings->GetConf('language', '')) {
										$bSaveSettings = true;
										$oSettings->SetConf('language', $sLanguage);
									}
								}
							}

							if ($bSaveSettings) {
								$oSettings->save();
							}
						}
					}
					catch (\Throwable $oException)
					{
						$this->oActions->logException($oException);
					}
				}
			}
		}

		\MailSo\Base\Http::Location('./');
		return '';
	}

	public function ErrorTemplates(string $sTitle, string $sDesc, bool $bShowBackLink = true) : string
	{
		return \strtr(\file_get_contents(APP_VERSION_ROOT_PATH.'app/templates/Error.html'), array(
			'{{ErrorTitle}}' => $sTitle,
			'{{ErrorHeader}}' => $sTitle,
			'{{ErrorDesc}}' => $sDesc,
			'{{BackLinkVisibilityStyle}}' => $bShowBackLink ? 'display:inline-block' : 'display:none',
			'{{BackLink}}' => $this->oActions->StaticI18N('BACK_LINK'),
			'{{BackHref}}' => './'
		));
	}

	private function localError(string $sTitle, string $sDesc) : string
	{
		\header('Content-Type: text/html; charset=utf-8');
		return $this->ErrorTemplates($sTitle, \nl2br($sDesc));
	}

	private function localAppData(bool $bAdmin = false) : string
	{
		\header('Content-Type: application/json; charset=utf-8');
		$this->oHttp->ServerNoCache();
		try {
			return Utils::jsonEncode($this->oActions->AppData($bAdmin));
		} catch (\Throwable $oException) {
			$this->Logger()->WriteExceptionShort($oException);
			\MailSo\Base\Http::StatusHeader(500);
			return $oException->getMessage();
		}
	}

	public function compileTemplates(bool $bAdmin = false) : string
	{
		$aTemplates = array();

		foreach (['Components', ($bAdmin ? 'Admin' : 'User'), 'Common'] as $dir) {
			$sNameSuffix = ('Components' === $dir) ? 'Component' : '';
			foreach (\glob(APP_VERSION_ROOT_PATH."app/templates/Views/{$dir}/*.html") as $file) {
				$sTemplateName = \basename($file, '.html') . $sNameSuffix;
				$aTemplates[$sTemplateName] = $file;
			}
		}

		$this->oActions->Plugins()->CompileTemplate($aTemplates, $bAdmin);

		$sHtml = '';
		foreach ($aTemplates as $sName => $sFile) {
			$sName = \preg_replace('/[^a-zA-Z0-9]/', '', $sName);
			$sHtml .= '<template id="'.$sName.'">'
				. \preg_replace('/<(\/?)script/i', '<$1x-script', \file_get_contents($sFile))
				. '</template>';
		}

		return \str_replace('&nbsp;', "\xC2\xA0", $sHtml);
	}
}
