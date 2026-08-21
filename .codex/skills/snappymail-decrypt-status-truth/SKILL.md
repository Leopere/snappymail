---
name: snappymail-decrypt-status-truth
description: "Use when changing or debugging SnappyMail message decryption, signature verification, Sent-folder encrypted message display, cached message bodies, PGP armor handling, or crypto status text."
---

# SnappyMail Decrypt Status Truth

## Purpose

The message view must tell the truth about crypto state. It may show decrypted only after decrypted content has replaced the armored body, and it may show verified only after a real signature verification succeeds with the correct public key; optimistic status flags, cached parse state, or partial helper success are not enough.

## Contract

Every fresh message parse starts with neutral crypto flags. Preserve an encrypted marker only while processing a top-level encrypted envelope, then mark it decrypted only after browser OpenPGP has replaced that envelope with parsed plaintext. A quoted or attached `-----BEGIN PGP MESSAGE-----` block is content, not evidence that the enclosing message is still encrypted. Sent mail is decryptable only when its ciphertext contains the sender's encryption subkey packet.

Private keys, private-key passphrases, decrypt, and verify operations are browser-only through the encrypted browser vault. Missing signer keys trigger bounded WKD refresh before final verification failure. Normal Forward and Reply must wait for `PgpUserStore.ready()` and a real decrypt result, then compose from visible plaintext; they must refuse unresolved armor. Forward as attachment is the only deliberate path that preserves the original encrypted RFC822 message.

## Code Map

Message parse state lives in `dev/Mime/Utils.js` and `dev/Model/Message.js`. The visible message workflow lives in `dev/View/User/MailBox/MessageView.js` and `dev/App/User.js`. Browser decrypt/verify key handling lives in `dev/Stores/User/OpenPGP.js` and `dev/Stores/User/Pgp.js`; `snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Pgp.php` only fetches encrypted MIME and public WKD data.
