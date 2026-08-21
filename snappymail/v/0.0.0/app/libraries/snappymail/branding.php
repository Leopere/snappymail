<?php

namespace SnappyMail;

abstract class Branding
{
	private const DEFAULT_PROFILE = 'mrc';
	private const PROFILES = array(
		'boompay' => array(
			'name' => 'BoomPay',
			'shortName' => 'BoomPay Mail',
			'description' => 'BoomPay webmail for Ontario repair businesses',
			'primaryColor' => '#C8201E',
			'secondaryColor' => '#1E7FD6',
			'themeColor' => '#0E1A2B',
			'themeName' => 'BoomPay',
			'faviconUrl' => 'brand/boompay-favicon.svg',
			'legacyFaviconUrl' => 'brand/boompay-favicon.ico',
			'appleTouchIconUrl' => 'brand/boompay-apple-touch-icon.png',
			'logoUrl' => 'brand/boompay-logo.svg',
			'manifestIconUrl' => 'brand/boompay-logo.webp',
			'manifestUrl' => 'brand/boompay-manifest.json',
			'allowThemes' => false
		),
		'mrc' => array(
			'name' => 'Motherboard Repair Canada',
			'shortName' => 'MRC Mail',
			'description' => 'Motherboard Repair Canada webmail',
			'primaryColor' => '#1A73E8',
			'secondaryColor' => '#4285F4',
			'themeColor' => '#1D3557',
			'themeName' => 'MotherboardRepairCanada',
			'faviconUrl' => 'brand/MRC_Logo_Main_Color.svg',
			'logoUrl' => 'brand/MRC_Logo_Main_Color.svg',
			'manifestIconUrl' => 'brand/MRC_Logo_Main_Color.svg',
			'manifestUrl' => 'brand/mrc-manifest.json',
			'allowThemes' => false
		)
	);

	private static function env(string $name, string $default = '') : string
	{
		$value = $_ENV[$name] ?? \getenv($name);
		return \is_string($value) && '' !== \trim($value) ? \trim($value) : $default;
	}

	private static function boolEnv(string $name, bool $default = false) : bool
	{
		$value = $_ENV[$name] ?? \getenv($name);
		if (!\is_string($value) || '' === \trim($value)) {
			return $default;
		}

		$value = \strtolower(\trim($value));
		if (\in_array($value, array('1', 'true', 'yes', 'on'), true)) {
			return true;
		}
		if (\in_array($value, array('0', 'false', 'no', 'off'), true)) {
			return false;
		}

		return $default;
	}

	private static function host() : string
	{
		$host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? '';
		$host = \strtolower(\trim((string) $host));
		$host = \preg_replace('/:\d+$/', '', $host);

		return \is_string($host) ? $host : '';
	}

	private static function hostMap() : array
	{
		$map = array(
			'mail.boompay.ca' => 'boompay',
			'boompay.ca' => 'boompay',
			'mail.nixc.us' => 'mrc'
		);
		$raw = static::env('BRAND_HOST_MAP');
		if ('' === $raw) {
			return $map;
		}

		foreach (\preg_split('/[;\n]+/', $raw) as $entry) {
			$entry = \trim($entry);
			if ('' === $entry || false === \strpos($entry, '=')) {
				continue;
			}
			[$host, $profile] = \array_map('trim', \explode('=', $entry, 2));
			$host = \strtolower($host);
			$profile = \strtolower($profile);
			if ('' !== $host && isset(static::PROFILES[$profile])) {
				$map[$host] = $profile;
			}
		}

		return $map;
	}

	private static function profileName() : string
	{
		$forced = \strtolower(static::env('BRAND_PROFILE'));
		if (isset(static::PROFILES[$forced])) {
			return $forced;
		}

		$host = static::host();
		foreach (static::hostMap() as $mappedHost => $profile) {
			if ($host === $mappedHost || \str_ends_with($host, '.' . $mappedHost)) {
				return $profile;
			}
		}

		return static::DEFAULT_PROFILE;
	}

	private static function value(string $key) : string
	{
		$profile = static::profileName();
		$profileEnv = 'BRAND_' . \strtoupper($profile) . '_' . \strtoupper($key);
		if ('' !== ($value = static::env($profileEnv))) {
			return $value;
		}

		return (string) (static::PROFILES[$profile][$key] ?? static::PROFILES[static::DEFAULT_PROFILE][$key] ?? '');
	}

	private static function boolValue(string $key) : bool
	{
		$profile = static::profileName();
		$profileEnv = 'BRAND_' . \strtoupper($profile) . '_' . \strtoupper($key);
		if ('' !== static::env($profileEnv)) {
			return static::boolEnv($profileEnv, (bool) (static::PROFILES[$profile][$key] ?? false));
		}

		return (bool) (static::PROFILES[$profile][$key] ?? static::PROFILES[static::DEFAULT_PROFILE][$key] ?? false);
	}

	private static function colorValue(string $key) : string
	{
		$default = (string) (static::PROFILES[static::profileName()][$key] ?? static::PROFILES[static::DEFAULT_PROFILE][$key]);
		$value = static::value($key);
		return \preg_match('/^#[0-9a-f]{6}$/i', $value) ? \strtoupper($value) : $default;
	}

	private static function staticPath(string $path) : string
	{
		return \RainLoop\Utils::WebStaticPath($path);
	}

	public static function imageType(string $url) : string
	{
		$path = \parse_url($url, PHP_URL_PATH);
		$extension = \strtolower(\pathinfo(\is_string($path) ? $path : $url, PATHINFO_EXTENSION));
		switch ($extension) {
			case 'svg':
				return 'image/svg+xml';
			case 'webp':
				return 'image/webp';
			case 'jpg':
			case 'jpeg':
				return 'image/jpeg';
			case 'ico':
				return 'image/x-icon';
		}
		return 'image/png';
	}

	private static function imageSizes(string $url) : string
	{
		return 'image/svg+xml' === static::imageType($url) ? 'any' : '512x512';
	}

	public static function name() : string
	{
		return static::value('name');
	}

	public static function shortName() : string
	{
		return static::value('shortName');
	}

	public static function description() : string
	{
		return static::value('description');
	}

	public static function primaryColor() : string
	{
		return static::colorValue('primaryColor');
	}

	public static function secondaryColor() : string
	{
		return static::colorValue('secondaryColor');
	}

	public static function themeColor() : string
	{
		return static::colorValue('themeColor');
	}

	public static function themeName() : string
	{
		return static::value('themeName');
	}

	public static function faviconUrl(string $configured = '') : string
	{
		return static::staticPath(static::value('faviconUrl'));
	}

	public static function legacyFaviconUrl() : string
	{
		$path = static::value('legacyFaviconUrl');
		return '' === $path ? '' : static::staticPath($path);
	}

	public static function appleTouchIconUrl() : string
	{
		$path = static::value('appleTouchIconUrl');
		return '' === $path ? '' : static::staticPath($path);
	}

	public static function logoUrl() : string
	{
		return static::staticPath(static::value('logoUrl'));
	}

	public static function manifestIconUrl() : string
	{
		return static::staticPath(static::value('manifestIconUrl'));
	}

	public static function manifestUrl() : string
	{
		return static::staticPath(static::value('manifestUrl'));
	}

	public static function title(string $configured = '') : string
	{
		return static::name();
	}

	public static function loadingDescription(string $configured = '') : string
	{
		return static::shortName();
	}

	public static function allowThemes(bool $configured = false) : bool
	{
		return static::boolValue('allowThemes');
	}

	public static function notomoSiteId() : string
	{
		return array(
			'boompay.ca' => 'boompay.ca',
			'mail.boompay.ca' => 'boompay.ca',
			'mail.nixc.us' => 'nixc.us'
		)[static::host()] ?? '';
	}

	public static function data(string $configuredFavicon = '') : array
	{
		return array(
			'name' => static::name(),
			'shortName' => static::shortName(),
			'description' => static::description(),
			'primaryColor' => static::primaryColor(),
			'secondaryColor' => static::secondaryColor(),
			'themeColor' => static::themeColor(),
			'themeName' => static::themeName(),
			'faviconUrl' => static::faviconUrl($configuredFavicon),
			'logoUrl' => static::logoUrl(),
			'manifestIconUrl' => static::manifestIconUrl(),
			'notomoSiteId' => static::notomoSiteId()
		);
	}

	public static function cssVariables() : string
	{
		return ':root{'
			. '--brand-primary-color:' . static::primaryColor() . ';'
			. '--brand-secondary-color:' . static::secondaryColor() . ';'
			. '--brand-theme-color:' . static::themeColor() . ';'
			. '}';
	}

	public static function manifest() : array
	{
		$icon = static::manifestIconUrl();
		return array(
			'name' => static::name(),
			'short_name' => static::shortName(),
			'description' => static::description(),
			'display' => 'standalone',
			'background_color' => 'white',
			'theme_color' => static::themeColor(),
			'icons' => array(
				array(
					'src' => static::faviconUrl(),
					'sizes' => 'any',
					'type' => 'image/svg+xml',
					'purpose' => 'any'
				),
				array(
					'src' => $icon,
					'sizes' => static::imageSizes($icon),
					'type' => static::imageType($icon),
					'purpose' => 'any maskable'
				)
			),
			'start_url' => \RainLoop\Utils::WebPath() ?: './'
		);
	}
}
