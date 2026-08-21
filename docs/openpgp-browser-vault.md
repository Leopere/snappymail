# Browser OpenPGP Vault

## Scope

This is a clean-start deployment. Existing browser private-key storage and
server GnuPG private-key state are deliberately discarded. The first successful
mail login creates a fresh browser-only OpenPGP identity for that mailbox and
publishes its public key through WKD. Old encrypted mail is outside this
deployment's recovery contract.

## Security boundary

OpenPGP private keys are generated, decrypted, used, and cleared in the
browser. The application server stores only an opaque encrypted vault record,
the associated public key, and a revision number. It never receives private-key
armor, an OpenPGP key passphrase, a decrypted vault key, or a device key.

The mailbox password necessarily reaches the server for IMAP/SMTP login. After
that login succeeds, the browser retains it only long enough to create or
unwrap the opaque vault password wrapper, then releases its in-memory
reference. The server does not persist the password as vault material and does
not derive or decrypt a vault key from it.

This is browser-side cryptography, not protection from a hostile server capable
of serving altered JavaScript. That stronger threat model requires an
independently verified client such as a signed extension or native application.

## Vault Format

Version 2 has two independent access paths to the same random 256-bit vault
key:

1. AES-256-GCM encrypts the JSON payload containing the private OpenPGP key,
   its random internal passphrase, and the active fingerprint.
2. A PBKDF2-HMAC-SHA-256 wrapper uses the current mailbox password, a unique
   128-bit salt, and 600,000 iterations to wrap the vault key with AES-256-GCM.
   This wrapper is the only vault-key wrapper stored on the server.
3. Each browser creates a non-extractable AES-GCM device key in IndexedDB. It
   stores a second, local-only AES-GCM ciphertext of the vault key next to that
   device key. No raw vault key or private-key armor is written to
   `localStorage`, cookies, or IndexedDB.

AES-GCM additional authenticated data binds every ciphertext to the normalized
mailbox address and purpose. A vault copied to another mailbox cannot be
opened. The server validates the exact version-2 schema and rejects any request
that contains private-key armor outside the opaque ciphertext.

## Lifecycle

On the first successful login, the browser silently generates a Curve25519
OpenPGP identity, creates the encrypted vault, saves the opaque record, stores
its local device wrapper, and publishes the public key to WKD. Saving succeeds
only after the server confirms that the exact public key is present at the
mailbox's hashed WKD object; a failed publication restores the prior record.
There is no vault setup, recovery-secret, migration, or key passphrase prompt.

On later visits from the same browser, the IndexedDB device wrapper unlocks the
vault without an extra interaction. On a new browser, the successful login
password unlocks the server-held password wrapper and creates that browser's
local device wrapper.

When a user changes their mailbox password and then signs in on a browser that
already has the device wrapper, the browser opens the existing vault locally
and silently rewraps it with the new password. The OpenPGP identity and old
mail access are unchanged. If every existing browser has been erased before an
external password change, no zero-knowledge system can silently recover the old
vault without an additional recovery secret or a server-held decryption key;
this deployment intentionally does neither.

Logout and automatic logout clear decrypted private keys, the raw vault key,
and private-key passphrases from browser memory. The local device wrapper stays
encrypted at rest so the next authenticated visit can be hands-free.

## Clean-Start Cleanup

The browser removes the old unprotected `openpgp-private-keys` local-storage
entry on bootstrap. When it writes a mailbox's first version-2 vault, the
server removes that mailbox's legacy GnuPG directory, historical GnuPG
passphrase file, and legacy private-key backup state. Mail, non-PGP account
settings, WKD routing, and tunnels are not modified by this cleanup.

## Send And Receive Contract

The browser fetches a fresh public WKD key for every To/Cc/Bcc recipient through
bounded discovery. When every recipient and the sender vault are usable, it
signs and encrypts to those recipients and the sender, then checks the resulting
recipient packets against every selected encryption subkey before handing the
armored result to SMTP unchanged. A cached key cannot bypass a failed fresh
lookup. If any key is missing, the vault is unavailable, browser crypto fails,
or encrypted attachments are unsupported, compose retains every recipient,
and blocks same-domain delivery. For external or mixed-domain delivery, it
shows a plaintext warning and requires confirmation before sending the original
message. It never partially encrypts a recipient set. The server retrieves
encrypted MIME parts and signed MIME material but does not decrypt, sign, or
verify OpenPGP mail.

Decryption and signature status are successful only after browser OpenPGP
processing has produced plaintext and completed the signature verification
promise. Encrypted attachments remain blocked until the browser can construct
the complete encrypted MIME tree without a server crypto fallback.
