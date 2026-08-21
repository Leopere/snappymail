<?php

namespace SnappyMail\PGP;

defined('GNUPG_SIG_MODE_NORMAL') || define('GNUPG_SIG_MODE_NORMAL', 0);
defined('GNUPG_SIG_MODE_DETACH') || define('GNUPG_SIG_MODE_DETACH', 1);
defined('GNUPG_SIG_MODE_CLEAR') || define('GNUPG_SIG_MODE_CLEAR', 2);

use SnappyMail\GPG\PGP as GPG;

abstract class GnuPG
{
	public static function isSupported() : bool
	{
		return GPG::isSupported() || PECL::isSupported();
	}

	public static function getInstance(string $homedir) : ?PGPInterface
	{
		if (GPG::isSupported()) {
			return new GPG($homedir);
		}
		if (PECL::isSupported()) {
			return new PECL($homedir);
		}
		return null;
	}
}
