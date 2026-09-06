---
name: snappymail-send-encryption-contract
description: "Use when changing or reviewing SnappyMail compose/send OpenPGP behavior: encrypt-to-self, recipient key selection, bounded WKD refresh, internal automatic signing/encryption, or server recipient validation."
---

# SnappyMail Send Encryption Contract

## Purpose

Sending encrypted mail must be deterministic, fast, and boring: build the recipient set, find the usable public keys, sign with the sender, encrypt once, and send. The encryption recipient set always includes every To/Cc/Bcc recipient plus the sender, because encrypt-to-self is required for Sent-folder readability and is not evidence that users share private keys.

## Contract

Every To/Cc/Bcc recipient must produce a fresh, domain-owned public WKD result at send time before automatic encryption is used. A browser-cached key, an app-local key copy, or a failed WKD lookup is not proof that the recipient currently publishes that key. WKD discovery is bounded to two seconds and validates the exact mailbox UID and a usable encryption subkey in the browser. An absent or unusable key means the address may be new, mistyped, not logged in yet, or non-OpenPGP.

There is never partial-recipient encryption. An unavailable fresh WKD key, sender vault, browser encryption, or encrypted-attachment capability must not prevent ordinary delivery. For same-domain, external, and mixed-domain mail, compose keeps the exact recipient set and requires explicit confirmation before sending the whole message plaintext. The server validates sender ownership but does not require OpenPGP solely because recipients share the sender's domain. When every prerequisite is available, the browser encrypts to every recipient plus the sender, then re-parses the new ciphertext and verifies that every selected encryption subkey ID has a recipient packet. Raw-armored forwarding remains disallowed. Server code never signs, encrypts, decrypts, or receives a private key.

## Code Map

Compose recipient construction and plaintext-fallback policy live in `dev/View/Popup/Compose.js`. Browser key discovery, recipient-packet verification, and the browser vault live in `dev/Stores/User/OpenPGP.js` and `dev/Storage/OpenPgpVault.js`. Domain-owned WKD lookup and vault-public-key publication are in `snappymail/v/0.0.0/app/libraries/snappymail/pgp/keyservers.php`, `snappymail/v/0.0.0/app/libraries/snappymail/pgp/wkd.php`, and `snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Pgp.php`. `Messages.php` only transports browser-produced armored content.

## Verification

Run `npm run test:openpgp` while changing this behavior. Before calling an
OpenPGP change complete, run `npm run verify:openpgp`; it rebuilds, compares the
public bundles with the local build, and runs a real nixc-to-BoomPay QA send,
decrypt, and forward. A stale cache bypass, missing plaintext warning, packet
mismatch, raw armor after decrypt, timeout, or asset mismatch is a failed gate.
A missing WKD key is a tested plaintext fallback for both external and
same-domain recipients; canceling confirmation must leave the message unsent. See
`docs/openpgp-verification.md`.
