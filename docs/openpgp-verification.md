# OpenPGP Verification Gate

OpenPGP work is not complete until the applicable checks below pass. Do not
interpret a green message-view status, a successful SMTP response, or a WKD
`200` alone as proof that the recipient can decrypt the ciphertext.

## Commands

Run the deterministic contract suite during normal development:

```sh
npm run test:openpgp
```

It checks the browser vault boundary, fresh-WKD policy, bounded advanced-WKD
retry and direct fallback, exact recipient packet assertion, vault publication
rollback, forwarding rules, and browser OpenPGP cryptography with independently
generated test keys.

Run the complete release gate after rebuilding and deploying an OpenPGP change:

```sh
npm run verify:openpgp
```

This builds the browser bundle with a continuity check, lints the source, runs the deterministic suite,
and runs `npm run test:openpgp:live`. The live test is intentionally strict: it
first compares the local `libs.min.js`, `app.min.js`, and `openpgp.min.js`
SHA-256 values with both public webmail hosts. It fails when the complete current
browser bundle has not actually reached the public instances.
The build stages replacements and atomically publishes each minified file, with
the bootstrap published last, so a normal rebuild cannot remove or truncate the
bootstrap bundle on an active instance.

## Live Contract

The live test uses only dedicated `snappyqa-*` accounts. It requires either
`SNAPPYMAIL_AUDIT_ENV` pointing to the local audit environment file, or these
environment values:

```text
SNAPPYMAIL_AUDIT_NIXC_A_EMAIL
SNAPPYMAIL_AUDIT_NIXC_A_PASSWORD
SNAPPYMAIL_AUDIT_BOOMPAY_B_EMAIL
SNAPPYMAIL_AUDIT_BOOMPAY_B_PASSWORD
```

The ordinary external-user path has no provider toggle, contact-key import,
key-generation screen, or trust prompt. As a read-only interoperability probe,
the live gate enters Proton's public `contact@proton.me` address in a normal
compose window and requires automatic signing and encryption, distinct Proton
and encrypt-to-self recipient packets, and no plaintext warning. It never sends
the probe message.

It sends one uniquely marked QA message in each direction and verifies all of
these conditions:

1. Each public sender obtains a current public WKD key for the opposite-domain
   recipient.
2. Each browser ciphertext has the recipient encryption subkey packet and the
   sender encrypt-to-self packet.
3. A nonexistent WKD recipient keeps the full recipient set, prepares one
   plaintext message, warns the user, and requires an explicit “Send plaintext”
   decision. Cancel keeps the compose contents intact and makes no send request.
4. A stale browser-cached key cannot bypass a failed fresh WKD lookup; a forced
   browser encryption failure blocks same-domain mail. External or mixed-domain
   mail restores plaintext and requires confirmation.
   Fresh discovery also waits for the login-time public-key list to finish loading,
   so an in-progress vault startup cannot overwrite the newly discovered key.
5. The recipient decrypts the actual delivered mail and verifies its signature in the browser.
6. A normal forward contains decrypted plaintext, never the original PGP armor.

Every live run writes a non-secret timing and stage report under
`tmp/openpgp-contract/<run-id>/report.json`. A nonzero exit status, missing
report step, public-bundle hash mismatch, timeout, raw armor after decrypt, or
recipient-packet mismatch is a failed gate. Do not restart or alter tunnel
clients as part of this test. A browser-stage failure also records a bounded
page-state summary, console errors, bounded browser request/response traces,
failed requests/responses, and a local screenshot beside the report for diagnosis.
It includes the current message decrypt/signature/forward state when available.
The browser bootstrap itself also bounds and retries its `AppData` request once,
so a stalled initial request cannot leave the user on an indefinite loading spinner.

## CI

`.github/workflows/openpgp-contract.yml` builds the browser assets, runs
`npm run check`, and runs `npm run test:openpgp` on pull requests and `master`
pushes. CI proves the deterministic contract only; it cannot replace
`npm run verify:openpgp`, because the latter validates the real public BoomPay
and nixc deployment.
