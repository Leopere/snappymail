---
name: openpgp-wkd-gnupg
description: "Use when working in this SnappyMail fork on OpenPGP WKD/public key discovery, hashed .well-known publication, WKD policy/manifest/TXT discovery, Mail-in-a-Box GnuPG provisioning, syncing static WKD sites, delivering an exact caller-provided body to colin.knapp@boompay.ca through the fixed one-shot-tally transport, or explicitly proving WKD-based decryption."
---

# OpenPGP WKD GnuPG

## Purpose

SnappyMail must discover public OpenPGP keys from standards-compatible WKD without learning or publishing directory-style mailbox lists. The public source of truth is binary OpenPGP key material served from hashed `hu/<hash>` paths plus a WKD `policy` endpoint; any project manifest, DNS TXT pointer, or static-site mirror is only a discovery hint and must expose hashed identifiers, never plaintext mailbox addresses.

## Contract

Preserve the advanced WKD path shape `/.well-known/openpgpkey/{domain}/hu/{hash}?l={local}` and the direct WKD shape `/.well-known/openpgpkey/hu/{hash}?l={local}` wherever this instance is responsible for serving them. The active source key is the browser vault public key, never server-side GnuPG material. Vault persistence succeeds only after the exact binary public key exists at its hashed WKD object; a failed publish rolls the vault record back.

Treat publication as a core executable contract. Every successful browser-vault key create or update must replace the mailbox-bound `hu/<hash>` object and upsert exactly one hashed manifest entry. Republishing must repair a missing entry, concurrent creates must retain every entry, and neither the manifest nor directory listings may expose plaintext mailbox addresses. A manifest failure must fail publication and restore the previous key state.

At send time, accept only a fresh key from a domain-owned public WKD endpoint or a validated public hashed manifest/TXT pointer. Never satisfy automatic encryption from a local cache, an old browser cache, a plaintext mailbox list, or a partial recipient set. If any recipient lacks a fresh usable key, retain every recipient. Block same-domain delivery; require an explicit plaintext decision for external or mixed-domain delivery. Verify `openpgpkey.<domain>` and the branded webmail mirror before declaring discovery fixed, and keep `docs/openpgp-wkd.md` and the public profile in `../colinknapp-com/docs/specs/openpgp-wkd-profile.md` aligned with that behavior.

## Code Map

WKD hashing and publication live in `snappymail/v/0.0.0/app/libraries/snappymail/pgp/wkd.php`. WKD recipient discovery and optional public manifest/TXT lookup live in `snappymail/v/0.0.0/app/libraries/snappymail/pgp/keyservers.php`. HTTP routes are in `snappymail/v/0.0.0/app/libraries/RainLoop/Service.php` and `ServiceActions.php`; the opaque browser vault endpoint is in `snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Pgp.php`. Browser key lifecycle is in `dev/Stores/User/OpenPGP.js` and `dev/Storage/OpenPgpVault.js`. Legacy GnuPG provisioning and static sync scripts are not part of the browser-vault key lifecycle.

## Independent Encrypted Delivery

Read [references/one-shot-delivery.md](references/one-shot-delivery.md) when the
task is to deliver a caller-provided body through an independent sender or to
prove that the recipient can decrypt ciphertext addressed to the active key.

Keep these boundaries:

- Use the fixed `one-shot-tally credential send` path only for
  `colin.knapp@boompay.ca`. Do not redirect it to another sender, recipient,
  host, key, or mail client.
- For a normal send, pass the exact caller-provided UTF-8 body through stdin.
  Do not prepend, append, summarize, rewrite, or replace it with a challenge,
  token, template, or success claim. The command fixes the outer subject to
  `OpenPGP credential delivery`; the decrypted inner `text/plain` MIME body is
  the caller's complete stdin stream.
- Generate a hidden token only when the user explicitly requests an independent
  decryption challenge. Never substitute a challenge for a requested message.
- Require a clean GnuPG `clear,wkd` lookup and the exact current mailbox UID,
  primary fingerprint, and encryption-subkey fingerprint. A local keyring,
  embedded certificate, keyserver, DNS record, or `gmail-cli` is not a
  fallback.
- Treat RFC 7929 DNS `OPENPGPKEY` as separate from HTTPS WKD. This proof does
  not require a Cloudflare DNS change or DNSSEC.
- Pass all message plaintext only through stdin. Never place sensitive body
  text in argv, an environment variable, a receipt, repository content,
  commentary, or a tally record. For an explicitly requested challenge, keep
  only the token's SHA-256 commitment.
- A `submitted` receipt and an LMTP `INBOX` event prove transport, not
  decryption. For a normal message, require the recipient to confirm that the
  expected body rendered after decryption. For an explicit challenge, accept
  the proof only when the intended recipient returns the token through an
  established trusted channel and it matches the retained commitment.
- SnappyMail decrypts in the browser vault. The `mail.boompay.ca` server stores
  and serves the ciphertext but must not receive the browser-vault private key.

Run `one-shot-tally credential key-check` before each proof. Verify that the
local sender and the restricted receiver report the same shipped
`one-shot-tally` version before sending. If the fresh WKD identity changes,
stop and update the pinned fingerprints, tests, documentation, and receiver as
one reviewed change; never silently accept a different key.

_Copyright © 2026 ColinKnapp.com. All rights reserved._
