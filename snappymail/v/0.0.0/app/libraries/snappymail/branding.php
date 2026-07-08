<?php

namespace SnappyMail;

abstract class Branding
{
	private const DEFAULT_NAME = 'Motherboard Repair Canada';
	private const DEFAULT_SHORT_NAME = 'MRC Mail';
	private const DEFAULT_DESCRIPTION = 'Brandable webmail for Motherboard Repair Canada';
	private const DEFAULT_PRIMARY_COLOR = '#1A73E8';
	private const DEFAULT_SECONDARY_COLOR = '#4285F4';
	private const DEFAULT_THEME_COLOR = '#1D3557';
	private const DEFAULT_THEME_NAME = 'MotherboardRepairCanada';

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

	private static function color(string $name, string $default) : string
	{
		$value = static::env($name, $default);
		return \preg_match('/^#[0-9a-f]{6}$/i', $value) ? \strtoupper($value) : $default;
	}

	private static function staticPath(string $path) : string
	{
		return \RainLoop\Utils::WebStaticPath($path);
	}

	public static function name() : string
	{
		return static::env('BRAND_NAME', static::DEFAULT_NAME);
	}

	public static function shortName() : string
	{
		return static::env('BRAND_SHORT_NAME', static::DEFAULT_SHORT_NAME);
	}

	public static function description() : string
	{
		return static::env('BRAND_DESCRIPTION', static::DEFAULT_DESCRIPTION);
	}

	public static function primaryColor() : string
	{
		return static::color('BRAND_PRIMARY_COLOR', static::DEFAULT_PRIMARY_COLOR);
	}

	public static function secondaryColor() : string
	{
		return static::color('BRAND_SECONDARY_COLOR', static::DEFAULT_SECONDARY_COLOR);
	}

	public static function themeColor() : string
	{
		return static::color('BRAND_THEME_COLOR', static::DEFAULT_THEME_COLOR);
	}

	public static function themeName() : string
	{
		return static::env('BRAND_THEME_NAME', static::DEFAULT_THEME_NAME);
	}

	public static function faviconUrl(string $configured = '') : string
	{
		return static::env('BRAND_FAVICON_URL', static::staticPath('brand/boot-logo.svg'));
	}

	public static function logoUrl() : string
	{
		return static::env('BRAND_LOGO_URL', static::staticPath('brand/MRC_Logo_Main_Color.svg'));
	}

	public static function manifestIconUrl() : string
	{
		return static::env('BRAND_MANIFEST_ICON_URL', static::staticPath('brand/boot-logo-512.png'));
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
		return static::boolEnv('BRAND_ALLOW_THEMES', false);
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
			'manifestIconUrl' => static::manifestIconUrl()
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
					'sizes' => '512x512',
					'type' => 'image/png',
					'purpose' => 'any maskable'
				)
			),
			'start_url' => \RainLoop\Utils::WebPath() ?: './'
		);
	}
}
