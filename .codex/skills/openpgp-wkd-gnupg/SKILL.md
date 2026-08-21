---
name: openpgp-wkd-gnupg
description: "Use when working in this SnappyMail fork on OpenPGP WKD/public key discovery, hashed .well-known publication, WKD policy/manifest/TXT discovery, Mail-in-a-Box GnuPG provisioning, or syncing static WKD sites."
---

# OpenPGP WKD GnuPG

## Purpose

SnappyMail must discover public OpenPGP keys from standards-compatible WKD without learning or publishing directory-style mailbox lists. The public source of truth is binary OpenPGP key material served from hashed `hu/<hash>` paths plus a WKD `policy` endpoint; any project manifest, DNS TXT pointer, or static-site mirror is only a discovery hint and must expose hashed identifiers, never plaintext mailbox addresses.

## Contract

Preserve the advanced WKD path shape `/.well-known/openpgpkey/{domain}/hu/{hash}?l={local}` and the direct WKD shape `/.well-known/openpgpkey/hu/{hash}?l={local}` wherever this instance is responsible for serving them. The active source key is the browser vault public key, never server-side GnuPG material. Vault persistence succeeds only after the exact binary public key exists at its hashed WKD object; a failed publish rolls the vault record back.

At send time, accept only a fresh key from a domain-owned public WKD endpoint or a validated public hashed manifest/TXT pointer. Never satisfy automatic encryption from a local cache, an old browser cache, a plaintext mailbox list, or a partial recipient set. If any recipient lacks a fresh usable key, retain every recipient. Block same-domain delivery; require an explicit plaintext decision for external or mixed-domain delivery. Verify `openpgpkey.<domain>` and the branded webmail mirror before declaring discovery fixed, and keep `docs/openpgp-wkd.md` and the public profile in `../colinknapp-com/docs/specs/openpgp-wkd-profile.md` aligned with that behavior.

## Code Map

WKD hashing and publication live in `snappymail/v/0.0.0/app/libraries/snappymail/pgp/wkd.php`. WKD recipient discovery and optional public manifest/TXT lookup live in `snappymail/v/0.0.0/app/libraries/snappymail/pgp/keyservers.php`. HTTP routes are in `snappymail/v/0.0.0/app/libraries/RainLoop/Service.php` and `ServiceActions.php`; the opaque browser vault endpoint is in `snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Pgp.php`. Browser key lifecycle is in `dev/Stores/User/OpenPGP.js` and `dev/Storage/OpenPgpVault.js`. Legacy GnuPG provisioning and static sync scripts are not part of the browser-vault key lifecycle.
