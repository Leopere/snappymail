---
name: openpgp-wkd-gnupg
description: Use when working in this SnappyMail fork on OpenPGP WKD, server-side GnuPG, automatic internal encryption/signing, recipient key discovery, Mail-in-a-Box GnuPG provisioning, or static WKD publication.
---

# OpenPGP WKD GnuPG

## Overview

This repository has a server-managed OpenPGP path. Treat WKD plus server-side GnuPG as a first-class feature, not a one-off patch.

Use `docs/openpgp-wkd.md` as the local architecture note before changing behavior.

## Core Rules

- Keep standards-compatible WKD as the public surface:
  - `/.well-known/openpgpkey/hu/{hash}?l={local}`
  - `/.well-known/openpgpkey/{domain}/hu/{hash}?l={local}`
  - `/.well-known/openpgpkey/policy`
- Store and publish binary OpenPGP public key material, not armored text, at WKD `hu/<hash>` paths.
- Publish only keys backed by server-side GnuPG material for that account. Do not publish browser-only OpenPGP.js keys.
- Same-domain mail must remain interaction-free: create/import needed server GnuPG keys ahead of time, then sign and encrypt automatically at send time.
- External mail may discover keys with WKD. Only auto-encrypt external recipients when every recipient has a usable key; otherwise fail open to ordinary mail.
- Never add directory listing, index-of-addresses, or plaintext mailbox publication. The optional manifest extension may expose hashes only.

## Implementation Map

- WKD hashing, path validation, manifest filtering, and public-key publication: `snappymail/v/0.0.0/app/libraries/snappymail/pgp/wkd.php`
- WKD recipient discovery and optional TXT/manifest extension: `snappymail/v/0.0.0/app/libraries/snappymail/pgp/keyservers.php`
- GnuPG account keyring selection, import, publish, decrypt, verify, and key lookup actions: `snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Pgp.php`
- WKD HTTP routes and policy handling: `snappymail/v/0.0.0/app/libraries/RainLoop/Service.php` and `ServiceActions.php`
- Compose/send-time automation: `dev/View/Popup/Compose.js`, `dev/Stores/User/GnuPG.js`, and server send logic under `RainLoop/Actions/Messages.php`
- Mail-in-a-Box provisioning for all active users in a domain: `scripts/provision-miab-domain-gnupg.cjs`
- Static WKD mirroring into adjacent sites: `scripts/sync-wkd-static-sites.cjs`
- Local WKD tests: `tests/php/wkd-hash.php`

## Operational Checks

- For production Mail-in-a-Box domains, provision server-side keys with:

```sh
npm run provision:miab-gpg -- nixc.us
```

- To sync static `.well-known/openpgpkey` trees after key changes, run:

```sh
node scripts/sync-wkd-static-sites.cjs
```

- Before changing hashing, verify the local implementation against GnuPG WKD output when available:

```sh
php tests/php/wkd-hash.php
gpg-wks-client --print-wkd-hash user@example.com
```

## Documentation Targets

- Keep repo implementation docs in `docs/openpgp-wkd.md`.
- Keep the public deployment profile in `../colinknapp-com/docs/specs/openpgp-wkd-profile.md`.
- If behavior diverges from the public profile, update the implementation first or clearly mark the extension as non-standard.
