<?php
/**
 * Based on Sabre\DAV\Client
 * @copyright Copyright (C) 2007-2015 fruux GmbH (https://fruux.com/).
 * @author Evert Pot (http://evertpot.com/)
 * @license http://sabre.io/license/ Modified BSD License
 */

namespace SnappyMail\DAV;

class Client
{
	public string $urlPath;
	private string $lastRequestUrl = '';
	private float $deadline = 0;
	private int $requestTimeout = 15;

	const
		NS_DAV  = 'urn:DAV',
		NS_CARDDAV = 'urn:ietf:params:xml:ns:carddav';

	protected string $baseUri;

	protected $HTTP;

	/**
	 * Constructor
	 *
	 * Settings are provided through the 'settings' argument. The following
	 * settings are supported:
	 *
	 *   * baseUri
	 *   * userName (optional)
	 *   * password (optional)
	 *   * proxy (optional)
	 */
	function __construct(array $settings)
	{
		if (!isset($settings['baseUri'])) {
			throw new \ValueError('A baseUri must be provided');
		}
		$this->baseUri = \rtrim($settings['baseUri'], '/');

		$this->HTTP = \SnappyMail\HTTP\Request::factory(/*'socket'*/);
		$this->HTTP->proxy = $settings['proxy'] ?? null;
		if (!empty($settings['userName']) && !empty($settings['password'])) {
			$this->HTTP->setAuth(3, $settings['userName'], $settings['password']);
		} else {
			\SnappyMail\Log::warning('DAV', 'No user credentials set');
		}
		$this->HTTP->max_response_kb = 0;
		$this->requestTimeout = \max(1, \min(15, (int) ($settings['timeout'] ?? 15)));
		$this->HTTP->timeout = $this->requestTimeout;
		$deadline = (float) ($settings['deadline'] ?? 0);
		$this->deadline = $deadline > 0 ? \microtime(true) + \max(1, \min(15, $deadline)) : 0;
		$this->HTTP->max_redirects = 0;
	}

	public function currentUrl() : string
	{
		return $this->absoluteUrl($this->urlPath ?: '/');
	}

	public function isSameOrigin(string $url) : bool
	{
		$base = \parse_url($this->baseUri);
		$target = \parse_url($this->absoluteUrl($url));
		return \is_array($base) && \is_array($target)
			&& $this->origin($base) === $this->origin($target);
	}

	public function lastRequestPath() : string
	{
		$parts = \parse_url($this->lastRequestUrl);
		return \is_array($parts) && !empty($parts['path']) ? $parts['path'] : $this->urlPath;
	}

	/**
	 * Enable/disable SSL peer verification
	 */
	public function setVerifyPeer(bool $value) : void
	{
		$this->HTTP->verify_peer = $value;
	}

	/**
	 * Performs an actual HTTP request, and returns the result.
	 *
	 * If the specified url is relative, it will be expanded based on the base url.
	 */
	public function request(string $method, string $url = '', ?string $body = null, array $headers = array()) : \SnappyMail\HTTP\Response
	{
		$url = $this->absoluteUrl($url);
		\SnappyMail\Log::debug('DAV', "{$method} {$url}" . ($body ? "\n\t" . \str_replace("\n", "\n\t", $body) : ''));
		$this->HTTP->timeout = $this->remainingTimeout();
		$response = $this->HTTP->doRequest($method, $url, $body, $headers);
		if (\in_array((int) $response->status, [301, 302, 307, 308], true)) {
			$location = $response->getRedirectLocation();
			if (!$location || !$this->isSameOrigin($location)) {
				throw new \SnappyMail\HTTP\Exception("{$method} {$url}: unsafe DAV redirect", $response->status, $response);
			}
			\SnappyMail\Log::info('DAV', "{$response->status} Redirect {$url} to {$location}");
			$url = $this->absoluteUrl($location);
			$this->HTTP->timeout = $this->remainingTimeout();
			$response = $this->HTTP->doRequest($method, $url, $body, $headers);
		}
		if (300 <= $response->status) {
			throw new \SnappyMail\HTTP\Exception("{$method} {$url}", $response->status, $response);
		}
		$this->lastRequestUrl = $url;
		\SnappyMail\Log::debug('DAV', "{$response->status}: {$response->body}");

		return $response;
	}

	private function remainingTimeout() : int
	{
		if (!$this->deadline) {
			return $this->requestTimeout;
		}

		$remaining = (int) \floor($this->deadline - \microtime(true));
		if (1 > $remaining) {
			throw new \RuntimeException('DAV discovery deadline exceeded');
		}

		return \min($this->requestTimeout, $remaining);
	}

	private function absoluteUrl(string $url) : string
	{
		if (\preg_match('@^https?://@i', $url)) {
			return $url;
		}

		$parts = \parse_url($this->baseUri);
		if (!\is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
			throw new \UnexpectedValueException('Invalid DAV base URI');
		}
		if (\str_starts_with($url, '//')) {
			return $parts['scheme'] . ':' . $url;
		}

		$origin = $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
		return \str_starts_with($url, '/') ? $origin . $url : $origin . '/' . \ltrim($url, '/');
	}

	private function origin(array $parts) : string
	{
		$scheme = \strtolower((string) ($parts['scheme'] ?? ''));
		$host = \strtolower((string) ($parts['host'] ?? ''));
		$port = (int) ($parts['port'] ?? ('https' === $scheme ? 443 : 80));
		return $scheme . '://' . $host . ':' . $port;
	}

	/**
	 * Does a PROPFIND request
	 *
	 * The list of requested properties must be specified as an array, in clark
	 * notation.
	 *
	 * The returned array will contain a list of filenames as keys, and
	 * properties as values.
	 *
	 * The properties array will contain the list of properties. Only properties
	 * that are actually returned from the server (without error) will be
	 * returned, anything else is discarded.
	 *
	 * Depth should be either 0 or 1. A depth of 1 will cause a request to be
	 * made to the server to also return all child resources.
	 */
	public function propFind(string $url, array $properties, int $depth = 0) : array
	{
		$body = '<?xml version="1.0"?>' . "\n" . '<d:propfind xmlns:d="DAV:"><d:prop>';

		foreach ($properties as $property) {
			if (!\preg_match('/^{([^}]*)}(.*)$/', $property, $match)) {
				throw new \ValueError('\'' . $property . '\' is not a valid clark-notation formatted string');
			}
			if ('DAV:' === $match[1]) {
				$body .= "<d:{$match[2]}/>";
			} else {
				$body .= "<x:{$match[2]} xmlns:x=\"{$match[1]}\"/>";
			}
		}

		$body .= '</d:prop></d:propfind>';

		$response = $this->request('PROPFIND', $url, $body, array(
			"Depth: {$depth}",
			'Content-Type: application/xml'
		));

		/**
		 * Parse the WebDAV multistatus response body
		 */
		$responseXML = \simplexml_load_string(
			/**
			 * Convert all instances of the DAV: namespace to urn:DAV
			 *
			 * This is unfortunately needed, because the DAV: namespace violates the xml namespaces
			 * spec, and causes the DOM to throw errors
			 *
			 * This is used to map the DAV: namespace to urn:DAV. This is needed, because the DAV:
			 * namespace is actually a violation of the XML namespaces specification, and will cause errors
			 */
			\preg_replace("/xmlns(:[A-Za-z0-9_]*)?=(\"|\')DAV:(\\2)/", "xmlns\\1=\\2urn:DAV\\2", $response->body),
			null, LIBXML_NOBLANKS | LIBXML_NOCDATA);

		if (false === $responseXML) {
			throw new \UnexpectedValueException("The passed data is not valid XML\n{$response->body}");
		}

		$ns = \array_search('urn:DAV', $responseXML->getNamespaces(true)) ?: 'd';
//		$ns_card = \array_search('urn:ietf:params:xml:ns:carddav', $responseXML->getNamespaces(true));

		$result = array();

		$responseXML->registerXPathNamespace($ns, 'urn:DAV');
		foreach ($responseXML->xpath("{$ns}:response") as $response) {
			$properties = array();
			$response->registerXPathNamespace($ns, 'urn:DAV');
			foreach ($response->xpath("{$ns}:propstat") as $propStat) {
				// Parse all WebDAV properties
				$propList = array();
				$propStat->registerXPathNamespace($ns, 'urn:DAV');
				foreach ($propStat->xpath("{$ns}:prop") as $prop) {
					foreach ($prop->xpath("*") as $element) {
						$propertyName = self::toClarkNotation($element);
						$propList[$propertyName] = [];
						if ('{DAV:}resourcetype' === $propertyName) {
							foreach ($element->xpath("*") as $resourcetype) {
								$propList[$propertyName][] = self::toClarkNotation($resourcetype);
							}
						} else {
							foreach ($element->xpath("*") as $child) {
								$propList[$propertyName][self::toClarkNotation($child)] = (string) $child;
							}
							if (!$propList[$propertyName]) {
								$propList[$propertyName] = (string) $element;
							}
						}
					}
				}
				list($httpVersion, $statusCode, $message) = \explode(' ', $propStat->children('urn:DAV')->status, 3);
				$properties[$statusCode] = $propList;
			}

			$result[(string) $response->children('urn:DAV')->href] = $properties;
		}

		if (0 === $depth) {
			\reset($result);
			return \current($result)[200] ?? array();
		}

		return \array_map(function($statusList){
			return $statusList[200] ?? array();
		}, $result);
	}

	/**
	 * Returns the 'clark notation' for an element.
	 *
	 * For example, and element encoded as:
	 * <b:myelem xmlns:b="http://www.example.org/" />
	 * will be returned as:
	 * {http://www.example.org}myelem
	 *
	 * This format is used throughout the SabreDAV sourcecode.
	 * Elements encoded with the urn:DAV namespace will
	 * be returned as if they were in the DAV: namespace. This is to avoid
	 * compatibility problems.
	 */
	public static function toClarkNotation(\SimpleXMLElement $element) : string
	{
		// Mapping back to the real namespace, in case it was dav
		// Mapping to clark notation
		$ns = \array_values($element->getNamespaces())[0];
		return '{' . ('urn:DAV' == $ns ? 'DAV:' : $ns) . '}' . $element->getName();
	}
}
