---
name: snappymail-send-encryption-contract
description: "Use when changing or reviewing SnappyMail compose/send OpenPGP behavior: encrypt-to-self, recipient key selection, bounded WKD refresh, internal automatic signing/encryption, or server recipient validation."
---

# SnappyMail Send Encryption Contract

## Purpose

Sending encrypted mail must be deterministic, fast, and boring: build the recipient set, find the usable public keys, sign with the sender, encrypt once, and send. The encryption recipient set always includes every To/Cc/Bcc recipient plus the sender, because encrypt-to-self is required for Sent-folder readability and is not evidence that users share private keys.

## Contract

Every To/Cc/Bcc recipient must produce a fresh, domain-owned public WKD result at send time before automatic encryption is used. A browser-cached key, an app-local key copy, or a failed WKD lookup is not proof that the recipient currently publishes that key. WKD discovery is bounded to two seconds and validates the exact mailbox UID and a usable encryption subkey in the browser. An absent or unusable key means the address may be new, mistyped, not logged in yet, or non-OpenPGP; it is not a send error.

There is never partial-recipient encryption. If any recipient is unavailable through fresh WKD, or the sender vault, browser encryption, or encrypted-attachment capability is unavailable, compose keeps the exact recipient set, shows a non-blocking plaintext warning, and sends the whole message plaintext. When every prerequisite is available, the browser encrypts to every recipient plus the sender, then re-parses the new ciphertext and verifies that every selected encryption subkey ID has a recipient packet. Raw-armored forwarding remains disallowed. Server code never signs, encrypts, decrypts, or receives a private key.

## Code Map

Compose recipient construction and plaintext-fallback policy live in `dev/View/Popup/Compose.js`. Browser key discovery, recipient-packet verification, and the browser vault live in `dev/Stores/User/OpenPGP.js` and `dev/Storage/OpenPgpVault.js`. Domain-owned WKD lookup and vault-public-key publication are in `snappymail/v/0.0.0/app/libraries/snappymail/pgp/keyservers.php`, `snappymail/v/0.0.0/app/libraries/snappymail/pgp/wkd.php`, and `snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Pgp.php`. `Messages.php` only transports browser-produced armored content.

## Verification

Run `npm run test:openpgp` while changing this behavior. Before calling an
OpenPGP change complete, run `npm run verify:openpgp`; it rebuilds, compares the
public bundles with the local build, and runs a real nixc-to-BoomPay QA send,
decrypt, and forward. A stale cache bypass, missing plaintext warning, packet
mismatch, raw armor after decrypt, timeout, or asset mismatch is a failed gate.
An ordinary missing WKD key is a tested plaintext fallback. See
`docs/openpgp-verification.md`.
