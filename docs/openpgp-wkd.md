# OpenPGP WKD

SnappyMail uses Web Key Directory (WKD) for recipient key discovery.

Future agent work on this feature should use the repo-local Codex skill at
`.codex/skills/openpgp-wkd-gnupg/SKILL.md`. The skill maps the WKD/GnuPG
implementation files, deployment commands, and invariants for interaction-free
internal signing/encryption.

## Discovery

When a user composes to `local@example.com`, SnappyMail checks the recipient's
local WKD store first, then this project's DNS/root manifest extension, then
the standard WKD locations:

```text
TXT _openpgpkey.example.com
https://example.com/.well-known/openpgpkey/index.json
https://openpgpkey.example.com/.well-known/openpgpkey/example.com/index.json
```

The TXT record format is:

```text
v=OPENPGPKEY1; url=https://openpgpkey.example.com/.well-known/openpgpkey/example.com/index.json; alg=sha256-email-v1
```

The TXT `url` must point to a manifest `index.json`, not directly to a key.
It may be hosted at the domain apex, at `openpgpkey.<domain>`, or at a
domain-owned subhost whose path includes the destination domain.

The manifest is JSON:

```json
{
		"version": 1,
		"algorithm": "sha256-email-v1",
		"domain": "example.com",
		"generated_at": "2026-07-08T00:00:00.000Z",
		"entries": [
			{
				"email_hash": "<sha256(lowercase(local@example.com))>",
			"wkd_hash": "<zbase32-sha1-local>",
			"key_url": "https://openpgpkey.example.com/.well-known/openpgpkey/example.com/hu/<zbase32-sha1-local>"
		}
	]
}
```

SnappyMail computes the SHA-256 hash for the exact target recipient email,
compares it to `email_hash`, verifies the manifest `domain`, verifies the
entry's exact `wkd_hash`, and fetches only the matching `key_url`.

The manifest and key URLs are accepted only when they stay under one of the
domain-owned WKD paths:

```text
https://example.com/.well-known/openpgpkey/index.json
https://example.com/.well-known/openpgpkey/hu/<zbase32-sha1-local>
https://openpgpkey.example.com/.well-known/openpgpkey/example.com/index.json
https://openpgpkey.example.com/.well-known/openpgpkey/example.com/hu/<zbase32-sha1-local>
https://owned-subhost.example.com/.well-known/openpgpkey/example.com/index.json
https://owned-subhost.example.com/.well-known/openpgpkey/example.com/hu/<zbase32-sha1-local>
```

Accepted URLs must use HTTPS, must not contain username/password credentials,
and must not include query strings or fragments. `email_hash` is lowercase
64-character hex. `wkd_hash` is the 32-character zbase32 SHA-1 local-part hash
used by WKD.

If no manifest entry is found, SnappyMail checks the standard WKD locations:

```text
https://example.com/.well-known/openpgpkey/hu/<zbase32-sha1-local>?l=local
https://openpgpkey.example.com/.well-known/openpgpkey/example.com/hu/<zbase32-sha1-local>?l=local
```

If a key is found, SnappyMail imports that public key into the sender's GnuPG
keyring before encryption. Send-time encryption discovery is automatic: the
sender UI and server-side `SendMessage` path both attempt this discovery before
sending, so a known recipient key can be used without manual key import.

## Publishing

SnappyMail publishes public keys only for local accounts that have a matching
server-side GnuPG secret key. Publishing a public key without the corresponding
secret key in the account keyring can create mail that appears encrypted but
cannot be decrypted by the recipient in this webmail instance.

The local WKD store lives under:

```text
/var/lib/snappymail/_data_/_default_/openpgpkey/<domain>/hu/<hash>
```

`scripts/sync-wkd-static-sites.cjs` refreshes that local WKD store from
SnappyMail GnuPG keyrings and mirrors it into adjacent static sites:

```text
../boompay-ca/.well-known/openpgpkey/
../boompay-ca/docs/.well-known/openpgpkey/
../nixc-us/.well-known/openpgpkey/
../nixc-us/docs/.well-known/openpgpkey/
```

The script writes both the direct and advanced WKD layouts so either the domain
apex or an `openpgpkey.` host can serve the same keys.

## Privacy

The manifest intentionally avoids plaintext email addresses. It is still a
public hash list, so common addresses such as `admin`, `contact`, `info`, and
employee names can be guessed and compared offline. For this deployment, the
tradeoff is accepted so `mail.nixc.us`, `webmail.boompay.ca`, and static domain
roots can advertise available recipient keys even when the webmail host cannot
serve the destination domain's root `.well-known` directly.

Public manifests must not contain plaintext mailbox names or addresses. The
only recipient identifier in the manifest is `email_hash`, computed as
`sha256(lowercase(local@domain))`. Public key objects are stored under standard
WKD `hu/<zbase32-sha1-local>` paths so non-Snappy WKD clients can still fetch
keys from known locations.

The static-site publisher intentionally emits the same schema consumed by
SnappyMail: `version`, `algorithm`, `domain`, `generated_at`, and `entries`
containing `email_hash`, `wkd_hash`, and `key_url`.
