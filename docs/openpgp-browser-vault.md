# Browser OpenPGP Vault

## Scope

This deployment preserves existing OpenPGP identities. When a mailbox doesn't
have a browser vault, its next successful login first checks for a legacy
server GnuPG key. If that key can be recovered, the browser migrates and
re-protects it without changing its fingerprint. If no legacy key exists, the
browser creates a new identity and publishes it through WKD.

An incomplete or ambiguous legacy key blocks new-key creation. This fail-closed
behavior prevents SnappyMail from silently replacing an identity or making old
encrypted mail unreadable. Existing version-2 browser vaults continue to use
their current keys and format.

## Security boundary

New OpenPGP private keys are generated, decrypted, used, and cleared in the
browser. The application server stores only an opaque encrypted vault record,
the associated public key, and a revision number. It never receives a browser
vault key, browser device key, or private-key armor created by the browser.

During one-time legacy migration, the server exports the private key and
historical key passphrase that it already holds. It encrypts both to a new,
one-time browser transport key before returning them. The browser proves that
the passphrase unlocks the key, then immediately re-protects the same key with
a new random passphrase inside the encrypted vault. The HTTP response and logs
never contain raw private-key armor or a raw key passphrase.

An ordinary authenticated session can't request this export. A successful
password login issues a random, three-minute migration capability only when no
vault record exists. The server stores only its hash, binds it to that session
and normalized mailbox, and accepts it once. Switching to an additional account
can't reuse the capability. The browser removes it from the login response
before it initializes the rest of the application.

The mailbox password necessarily reaches the server for IMAP/SMTP login. After
that login succeeds, the browser retains it only long enough to create or
unwrap the opaque vault password wrapper, then releases its in-memory
reference. The server does not persist the password as vault material and does
not derive or decrypt a vault key from it.

This is browser-side cryptography, not protection from a hostile server capable
of serving altered JavaScript. That stronger threat model requires an
independently verified client such as a signed extension or native application.

## Vault format

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

On the first successful login without a vault, the browser requests an export
encrypted to an ephemeral transport key. A confirmed `detected: false` result
continues to fresh Curve25519 key generation. A complete legacy export instead
keeps the existing fingerprint, imports every recoverable historical key, and
uses the current WKD-matching key as the active identity. If no WKD key matches,
SnappyMail selects the legacy key only when exactly one usable mailbox key
exists. Any partial or ambiguous result stops without writing a vault or WKD
object. Expired or revoked historical keys remain in the vault for old-message
decryption, but can't become the active WKD identity.

After fresh creation or migration, the browser creates the encrypted vault,
saves the opaque record, and stores its local device wrapper. Saving succeeds
only after the server confirms that the exact active public key is present at
the mailbox's hashed WKD object. A failed publication restores the prior
record. This flow doesn't ask for a vault setup, migration, recovery secret, or
key passphrase.

An invalid, truncated, unsupported, or mailbox-mismatched existing vault is not
treated as missing. SnappyMail preserves its original bytes, blocks a
revision-zero replacement, and reports that recovery is required. Vault files
are stored under the active mailbox address so an additional account can't
read or overwrite its parent account's vault.

Older releases could write an additional account's vault under its parent
account, and could preserve a mixed-case mailbox path. Before bootstrap,
SnappyMail copies that opaque version-2 record to the mailbox named by its
public key, verifies that every byte matches, and only then removes the old
path. It does not decrypt, rewrap, or rotate the OpenPGP key during this storage
repair. A conflicting destination or an unidentifiable main-account record
stops without overwriting either copy.

Legacy detection is mailbox-scoped after SnappyMail successfully inspects the
old keyring and passphrase records. An empty keyring, or a parent keyring that
contains keys only for another account, does not block fresh identity creation.
An unreadable keyring or an incomplete matching key remains fail-closed.

On later visits from the same browser, the IndexedDB device wrapper unlocks the
vault without an extra interaction. On a new browser, the successful login
password unlocks the server-held password wrapper and creates that browser's
local device wrapper.

When a user changes their mailbox password and then signs in on a browser that
already has the device wrapper, the browser opens the existing vault locally
and silently rewraps it with the new password. The OpenPGP identity and old
mail access are unchanged.

If the device wrapper is unavailable but the user still knows the previous
mailbox password, Settings > Security provides an explicit recovery form. The
browser uses the previous password locally to unlock the existing vault. It
then verifies that the private key, active fingerprint, and stored mailbox
key still match. The current password must match the signed-in credential and
pass a fresh IMAP login. The server accepts only a replacement password wrapper
in that same request and preserves the payload ciphertext and public key byte
for byte. Retrying the exact wrapper after an interrupted response returns the
same committed revision without another write. A successful recovery
republishes a quarantined WKD key without rotating it, so previously encrypted
mail remains decryptable.

The recovery form does not change the mailbox password. Mailbox passwords must
still be changed through the account administrator or account portal. If every
existing browser has been erased and the previous password is also unknown, no
zero-knowledge system can recover the old vault without another recovery secret
or a server-held decryption key; this deployment intentionally uses neither.

Logout and automatic logout clear decrypted private keys, the raw vault key,
and private-key passphrases from browser memory. The local device wrapper stays
encrypted at rest so the next authenticated visit can be hands-free.

## Legacy key retention

The browser removes the old unprotected `openpgp-private-keys` local-storage
entry on bootstrap. Writing the first version-2 vault doesn't delete the
mailbox's legacy GnuPG directory, passphrase file, or historical key material.
The legacy purge endpoint remains disabled until a future flow can prove both
browser possession and old-message decryptability. This retention makes the
migration recoverable and doesn't modify mail, non-PGP account settings, WKD
routing, or tunnels.

## Send and receive contract

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
