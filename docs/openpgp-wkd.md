# OpenPGP WKD

SnappyMail uses Web Key Directory (WKD) to find the current public key for an
email recipient. It does not publish a mailbox directory. The active private
key is generated and used only in the browser vault; the server stores an
opaque encrypted vault record and the corresponding public key.

## Discovery

For `local@example.com`, the browser asks the authenticated SnappyMail endpoint
to fetch the exact hashed public object from domain-owned public WKD locations:

```text
https://openpgpkey.example.com/.well-known/openpgpkey/example.com/hu/<zbase32-sha1-local>?l=local
https://example.com/.well-known/openpgpkey/hu/<zbase32-sha1-local>?l=local
```

The domain after `@` is the identity domain and remains the discovery
authority. It is not replaced by the domain's MX target, SMTP or IMAP host, or
webmail hostname. For `colin@nixc.us`, standard discovery therefore stays at
`openpgpkey.nixc.us` and `nixc.us` even though the MX target is
`box.p.nixc.us`. A CNAME can route `openpgpkey.nixc.us` to another machine, but
it does not rewrite the HTTPS host or WKD path.

After standard WKD, SnappyMail may query the profile-defined TXT locator at
`_openpgpkey.<identity-domain>`:

```text
v=OPENPGPKEY1; alg=sha256-email-v1; url=https://.../manifest.json
```

The TXT owner is derived from the identity domain, never the MX target. Thus
`_openpgpkey.box.p.nixc.us` applies to `@box.p.nixc.us` identities, not to
`@nixc.us` identities. This TXT convention is a SnappyMail extension, not WKD
or the RFC 7929 `OPENPGPKEY` record.

The locator may advertise a nonstandard HTTPS manifest path on the identity
domain or one of its subdomains. SnappyMail accepts that path only from the
fixed identity-domain TXT record. The manifest may identify keys only at the
standard direct or advanced `hu/<hash>` WKD paths.

The manifest uses `version: 1`, `algorithm: sha256-email-v1`, the exact
identity `domain`, and an `entries` array. Each entry contains a 64-character
lowercase hexadecimal SHA-256 hash of the normalized full email address, the
32-character WKD z-base-32 hash, and an exact standard direct or advanced
`key_url`. The key URL has no query string, so the manifest never exposes the
plaintext local-part through WKD's optional `?l=` hint. Conflicting valid TXT
locators fail closed as ambiguous.

The local part is lowercased, SHA-1 hashed, and encoded with WKD z-base-32.
The browser validates that the returned OpenPGP key has the exact mailbox UID
and a usable encryption subkey. It may use a validated public hashed manifest
or DNS TXT pointer only after the standard public WKD paths, within the same
bounded lookup deadline.

Send-time lookup is authoritative for automatic encryption. A cached browser
key or application-local WKD copy cannot satisfy it. Every To/Cc/Bcc recipient
must return a fresh public WKD key before encryption is used. If any result is
absent, unusable, or times out, the address is treated as not ready for OpenPGP
(for example, it may be new, mistyped, or never logged in). For external or
mixed-domain mail, compose retains the complete recipient set and requires an
explicit plaintext decision. Mail where every recipient shares the sender's
domain fails closed until OpenPGP protection is available.

## Publishing

On first successful login, the browser creates an OpenPGP identity inside the
browser vault and submits only its opaque encrypted vault record plus public
key. The server atomically writes the exact binary public key to its
`hu/<hash>` object and upserts its hashed manifest entry. Create or update
succeeds only when both are present and match the submitted public key. If
publication fails, the server restores the previous key and opaque vault record
rather than leaving an unpublished recipient identity behind.

The public WKD response is authoritative. Branded webmail hosts may mirror the
advanced response for usability, but standards-based sender discovery uses the
recipient domain's `openpgpkey.` host and direct root WKD path. Static mirrors
must copy the same exact `hu/<hash>` objects; legacy GnuPG sync scripts are not
a source for browser-vault public keys. Static sync validates each object's UID,
mailbox hashes, and encryption capability before replacing a mirror.

## Send Contract

When every To/Cc/Bcc recipient has a fresh usable WKD key and the browser vault
is available, the browser encrypts to every recipient and the sender. It then
parses the ciphertext it just created and verifies a recipient packet for every
selected encryption subkey. There is no partial-recipient encryption and no
server-side OpenPGP operation. A missing key, vault failure, encryption error,
or unsupported encrypted attachment blocks same-domain delivery. For external
or mixed-domain delivery, it produces one plaintext message for every recipient
only after an explicit warning and confirmation.

## Privacy

Public WKD hosts expose only exact hashed `hu/<hash>` key objects and optional
hashed manifest entries. They must not expose plaintext mailbox lists,
directory listings, or an endpoint that enumerates recipient keys.
