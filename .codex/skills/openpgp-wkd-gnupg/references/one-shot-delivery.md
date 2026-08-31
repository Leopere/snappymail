# OpenPGP WKD One-Shot Delivery Runbook

> Proprietary operational material. This file and `one-shot-tally` are not
> licensed under any present or future open-source license for the surrounding
> SnappyMail fork. Copyright © 2026 ColinKnapp.com. All rights reserved.

Use this runbook to have an independent sender discover the current public key
for `colin.knapp@boompay.ca` and deliver the caller's exact UTF-8 body as
signed-and-encrypted PGP/MIME. Use the hidden-token variant only when the user
explicitly requests an independent decryption proof.

The fixed path is:

```text
caller-provided body through stdin
  -> clean GnuPG WKD lookup
  -> validate exact UID and encryption subkey
  -> sign and encrypt locally
  -> restricted SSH submission to box.p.nixc.us
  -> validated sendmail/Postfix handoff
  -> LMTP delivery to INBOX
  -> browser-vault decryption in SnappyMail
  -> recipient confirms the expected body

optional explicit proof: returned-token commitment match
```

## Protocol Boundaries

| Mechanism | Role in this proof |
| --- | --- |
| GnuPG `--auto-key-locate clear,wkd` | Required HTTPS key discovery |
| Advanced WKD at `openpgpkey.boompay.ca` | Current successful discovery endpoint |
| Direct WKD at `boompay.ca` | Standard fallback; must publish the same current key before relying on it |
| RFC 7929 DNS `OPENPGPKEY` | Separate optional DNS mechanism; not used |
| Cloudflare DNS or DNSSEC | Not required by this WKD delivery path |
| MX, IMAP, SMTP, or `mail.boompay.ca` hostname | Mail transport and UI, not the WKD identity authority |
| `gmail-cli` | Not used and not a fallback |

WKD is HTTPS discovery rooted in the recipient identity domain. RFC 7929
defines DNS `OPENPGPKEY` records and uses DNSSEC for authenticated DNS key
associations; it is not the GnuPG `wkd` lookup used here.

Do not say that the mail server decrypts the message. The server accepts and
stores ciphertext. SnappyMail decrypts in the authenticated browser with the
private key in the browser vault.

## Debugging Identity Evidence

These values record the successful August 2026 debugging session. They are
useful when comparing evidence, but they are not production recipient-key
pins. Production accepts the current clean WKD result only when it contains the
exact mailbox UID and a valid encryption-capable key.

| Field | Value |
| --- | --- |
| Recipient | `colin.knapp@boompay.ca` |
| WKD local-part hash | `b1rn8bjo3sd3c77q5iu4zpeo1xc5eon5` |
| Primary fingerprint | `6183F2DE176E9D46EDB602951B7D7262C3D0207D` |
| Encryption-subkey fingerprint | `9E5310E1F125CC2696E2C0385FE016062B506A77` |
| Encryption key ID | `5FE016062B506A77` |
| Sender | `colin@nixc.us` |
| Signing-subkey fingerprint | `33EA65A9C078126556C150E1EA43219BE7B419F1` |
| Receiver | `box.p.nixc.us:/usr/local/bin/one-shot-tally` |
| Shipped sender source | `0de5cdb27c765e29a3faa521ae090affd8200a5b` |
| Sender and receiver release | `one-shot-tally 1.16.0` |
| Receiver Linux artifact SHA-256 | `78bc01ca1bd1c4b2a17edd7aca8256cbb4f0e4969761b993e3da0603e484fcee` |

## Repeatable Procedure

### 1. Verify the sender and receiver

Use the installed binary from a shipped `../one-shot-tally` revision:

```sh
one-shot-tally version
one-shot-tally credential key-check

/usr/bin/ssh -F /dev/null -T \
  -oBatchMode=yes -oIdentitiesOnly=yes -oIdentityAgent=none \
  -oPreferredAuthentications=publickey -oPubkeyAuthentication=yes \
  -oPasswordAuthentication=no -oKbdInteractiveAuthentication=no \
  -oCertificateFile=none -oStrictHostKeyChecking=yes \
  -oUserKnownHostsFile="$HOME/.ssh/known_hosts" \
  -oGlobalKnownHostsFile=/dev/null -oHostKeyAlias=89.117.56.210 \
  -oConnectTimeout=10 -oConnectionAttempts=1 -oClearAllForwardings=yes \
  -oPermitLocalCommand=no -oControlMaster=no -oControlPath=none \
  -oControlPersist=no -i "$HOME/.ssh/id_ed25519" \
  root@box.p.nixc.us \
  'printf "%s  %s\n" "78bc01ca1bd1c4b2a17edd7aca8256cbb4f0e4969761b993e3da0603e484fcee" "/usr/local/bin/one-shot-tally" | sha256sum -c - && /usr/local/bin/one-shot-tally version'
```

`credential key-check` must report the exact recipient and the fingerprints
and key ID it observed. Fingerprints can differ after valid key rotation; they
are diagnostic output, not a production gate. Confirm the receiver runs the
exact expected artifact and release above. The read-only receiver check uses
the existing administrative key; the compiled sender uses its separate
forced-command credential key. If either key or the pinned host-key entry is
missing, stop instead of relaxing an SSH option. A version or hash mismatch is
a deployment problem, not a reason to bypass the receiver's validation.

When the receiver needs an update, ship and test `../one-shot-tally` first.
Build the exact shipped revision for static `linux/amd64`, calculate its
SHA-256 value, upload it under a revision-specific temporary name, and verify
that value on the receiver. Before changing the live path, verify the old live
hash, create a root-owned mode-0755 hash-named backup, install and verify a
temporary candidate, and atomically rename the candidate over the live path.
Then verify the live hash, version, and backup hash. Never stream an unchecked
binary directly over the live file.

A request to repeat this delivery or decryption challenge authorizes submission
through the existing receiver only. It does not authorize replacing the
production receiver binary. The current `../one-shot-tally/.deploy-it.json`
installs the sender locally and is not a remote receiver deployment contract.
Change the receiver only when the user explicitly authorizes that exact
production target and artifact, or after the user trusts a tracked contract
that owns the remote update. Otherwise, report the mismatch and stop before
mutation.

### 2. Diagnose WKD with an empty GnuPG home when needed

`credential key-check` is the normal preflight. For an independent diagnostic,
use a short temporary path on macOS so GnuPG's agent sockets stay below the
Unix-domain socket path limit:

```sh
wkd_home=$(mktemp -d /tmp/ost-wkd.XXXXXX)
chmod 700 "$wkd_home"
cleanup_wkd() {
  gpgconf --homedir "$wkd_home" --kill all >/dev/null 2>&1 || true
  find "$wkd_home" -depth -delete 2>/dev/null || true
}
trap cleanup_wkd EXIT HUP INT TERM

gpg --no-options --homedir "$wkd_home" --batch --no-tty \
  --no-auto-key-retrieve --auto-key-locate clear,wkd \
  --locate-external-key colin.knapp@boompay.ca
gpg --no-options --homedir "$wkd_home" --batch --with-colons \
  --list-keys colin.knapp@boompay.ca
```

`--no-options` prevents user configuration from adding discovery methods.
`clear,wkd` clears the method list and permits only WKD. The empty home prevents
a stale local certificate from satisfying the check. Kill the temporary GnuPG
processes before removing the directory.

### 3. Send the requested body

For a normal send, use the exact body the caller supplied. Do not add an
introduction, footer, challenge, token, template, delivery report, or success
claim unless it is part of the requested body.

Generate a fresh operation ID, then start the fixed sender:

```sh
message_operation=$(uuidgen | tr '[:upper:]' '[:lower:]')

one-shot-tally credential send \
  --operation-id "$message_operation" \
  --account snappymail-openpgp-message
```

Write or paste the body only through the command's stdin, then send EOF. In
automation, connect the existing body byte stream directly to stdin. Do not put
the body in argv or an environment variable.

The complete stdin stream becomes the decoded `text/plain; charset=utf-8`
inner MIME body byte-for-byte. The sender does not trim whitespace, normalize
line endings, prepend a template, or interpret the text as a token. Input must
be nonempty valid UTF-8, contain no NUL bytes, and not exceed 64 KiB.

The compiled command fixes the sender, recipient, signing key, recipient key,
SSH identity, receiver host, and outer subject. It passes only PGP/MIME
ciphertext to the receiver. Local and receiver receipts contain metadata and a
ciphertext hash, never plaintext or a plaintext hash.

Never retry an existing operation ID. Exit status 3 means the outcome is
unknown; resolve it from the receipt and mailbox before creating a new
operation.

#### Optional: send a hidden challenge

Use this variant only when the user explicitly requests a decryption challenge.
Do not substitute it for a requested email body.

Do not enable shell tracing. Generate the token at runtime, keep it in a
non-exported shell variable, pass the message through stdin, and erase the
variable immediately after the send. The command text and shell history then
contain no generated token.

```sh
challenge_operation=$(uuidgen | tr '[:upper:]' '[:lower:]')
challenge_token="BP-$(openssl rand -hex 16)"
challenge_commitment=$(printf '%s' "$challenge_token" | shasum -a 256 | awk '{print $1}')

if printf 'OpenPGP WKD one-shot challenge\n\nDecrypt this message and return the exact token.\n\nToken: %s\n' \
    "$challenge_token" |
    one-shot-tally credential send \
      --operation-id "$challenge_operation" \
      --account snappymail-openpgp-decryption-proof; then
  challenge_status=0
else
  challenge_status=$?
fi
unset challenge_token

printf 'operation_id=%s\ncommitment_sha256=%s\n' \
  "$challenge_operation" "$challenge_commitment"
exit "$challenge_status"
```

### 4. Verify transport and recipient display

Require all of these facts:

1. The sender prints `submitted` and writes a metadata-only local receipt.
2. The receiver receipt has the same operation ID, ciphertext SHA-256 value,
   byte count, fingerprints, sender, recipient, and `submitted` state.
3. Postfix and LMTP logs show the matching message ID stored in `INBOX`.
4. The recipient opens the message in SnappyMail and confirms that the expected
   body rendered after decryption.
5. For an explicitly requested challenge only, confirm that the intended
   recipient returned the token through an established trusted channel. Hash
   the token through silent stdin and compare it with the retained commitment.
   Do not repeat the token in the report or commit it to a file.

A transport receipt proves submission. An `INBOX` log proves delivery. Only
recipient confirmation proves that the expected body rendered after browser-
vault decryption. For an explicit challenge, the returned-token commitment
match provides evidence of successful recipient decryption only when the return
channel establishes the responder as the intended recipient. Without that
responder binding, the match proves only that someone returned the generated
token.

Signature verification is independent. “Signature could not be verified” can
coexist with successful decryption when the recipient has not discovered or
trusted the sender's public signing key.

## Verified Evidence From 2026-08-31

The successful clean lookup used GnuPG `clear,wkd` and selected the advanced
WKD response:

- advanced endpoint: HTTP 200, 543 bytes, primary fingerprint
  `6183F2DE176E9D46EDB602951B7D7262C3D0207D`, encryption subkey
  `9E5310E1F125CC2696E2C0385FE016062B506A77`;
- direct endpoint: HTTP 200, 418 bytes, different primary fingerprint
  `63A06C5869F21800CC1732CEB2E9F818ED16A256` and encryption subkey
  `54D4883C2840979A142FB8ACC78078C7B5CFE935`;
- branded advanced mirror at `mail.boompay.ca`: HTTP 404.

The endpoint mismatch is a publication defect to repair separately. It did not
prevent GnuPG from selecting the current advanced WKD key, and it does not
justify substituting the direct key into the one-shot sender.

Earlier failed ciphertext was addressed to stale or mismatched key material,
including legacy primary fingerprint
`AB4A9099D555B7EECE62E5833E2997E43D6092D8` with encryption key ID
`4D8582648569C9EA`, and an old local primary fingerprint
`41E32DA5C148003B2610C5DCA607C103D75F7E39`. “No decryption key packets
found” meant that none of the recipient's available secret keys matched a
public-key-encrypted session-key packet; SMTP delivery itself had succeeded.

Challenge 3 used the clean advanced-WKD key. SnappyMail reported successful
decryption, and the exact token returned by the recipient matched its retained
commitment. Do not record or reuse that token.

For challenge 4, the receiver was updated from `one-shot-tally 1.14.0` to the
shipped `1.16.0` artifact. The active artifact SHA-256 value was
`05b2cdc3f85354ee7ead07e6eac5df8f33275157be10f9d9a30a32c3edc0df81`;
the prior artifact was preserved at
`/usr/local/bin/one-shot-tally.backup-a74d4846a8c50e1c` with SHA-256
`a74d4846a8c50e1c7585082b1fbfc8daffe5065c1048410fd319a026ac28167c`.

Challenge 4 operation `ac7a17e9-622a-458e-b9a6-9bde6ceabdd9` was signed by
`33EA65A9C078126556C150E1EA43219BE7B419F1`, encrypted to
`9E5310E1F125CC2696E2C0385FE016062B506A77`, accepted by both metadata-only
receipts, scored clean by SpamAssassin, and stored in the recipient's `INBOX` by
LMTP. Its unrevealed-token SHA-256 commitment is
`e1b5728e3b80f7d32d7f2831ef57dd87e5c132b1cd59e721ec6f6218d7e34d60`.
The recipient returned the exact decrypted token. It was hashed through silent
stdin, and its SHA-256 value matched that commitment. Challenge 4 therefore
proved discovery, encryption, delivery, browser-vault decryption, and
possession of the matching private key. The token itself is intentionally
absent from the repository.

_Copyright © 2026 ColinKnapp.com. All rights reserved._
