---
name: snappymail-gnupg-key-lifecycle
description: "Use when changing SnappyMail server-side GnuPG key generation, key wiping, login bootstrap, passphrase vault capture, key rotation, duplicate key cleanup, or old-mail decryptability."
---

# SnappyMail GnuPG Key Lifecycle

## Purpose

Each mailbox gets exactly one current server-side GnuPG identity for newly sent mail, generated or repaired on successful login when missing. Old private keys may remain available only so older encrypted mail can still decrypt; they must not be republished, selected for new encryption, or allowed to make duplicate current identities look normal.

## Contract

The login password is captured on successful authentication as the server-side GnuPG passphrase source, then used hands-free for decrypt/sign/encrypt operations without asking the browser user to manage modal passwords. If a password or key rotation happens, define three outcomes before changing code: which key is current and published, which old keys remain decrypt-only, and how old passphrases are preserved or intentionally discarded. A pre-production wipe is allowed only after explicit confirmation and must be scoped to GnuPG keyrings, encrypted GnuPG passphrase vault data, generated WKD public-key output, and gpg-agent state; never delete mail, account settings, branding, tunnels, or `.cryptkey`.

## Code Map

Key lifecycle behavior is centered in `snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Pgp.php` and the login bootstrap in `snappymail/v/0.0.0/app/libraries/RainLoop/Actions/UserAuth.php`. Client private-key loading and passphrase memory live in `dev/Stores/User/GnuPG.js`. WKD publication must be checked through `snappymail/v/0.0.0/app/libraries/snappymail/pgp/wkd.php` after any lifecycle change.
