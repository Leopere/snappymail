# Browser OpenPGP Clean Cutover

This one-time deployment procedure resets exactly these mailboxes:

- `mike.lefler@boompay.ca`
- `mike.mcarthur@boompay.ca`
- `kevin.haywood@boompay.ca`
- `colin.knapp@boompay.ca`
- `colin@nixc.us`

It is deliberately local to the running SnappyMail container. It does not use
Mail-in-a-Box GnuPG provisioning, does not touch mail or account settings, and
does not inspect, restart, or alter tunnel clients.

## Required Order

1. Build and deploy the complete browser bundle set. Confirm the normal public
   bundle test can reach both public webmail hosts.
2. Put the five current mailbox passwords in a local-only environment file:

```sh
export SNAPPYMAIL_CUTOVER_MIKE_LEFLER_PASSWORD='...'
export SNAPPYMAIL_CUTOVER_MIKE_MCARTHUR_PASSWORD='...'
export SNAPPYMAIL_CUTOVER_KEVIN_HAYWOOD_PASSWORD='...'
export SNAPPYMAIL_CUTOVER_COLIN_KNAPP_PASSWORD='...'
export SNAPPYMAIL_CUTOVER_COLIN_NIXC_PASSWORD='...'
```

3. Inspect the exact scoped plan. This command is read-only:

```sh
npm run openpgp:cutover:plan
```

4. Manually execute the scrub only after reviewing that plan:

```sh
npm run openpgp:cutover:scrub -- --confirm SCRUB_BROWSER_OPENPGP_KEYS
```

The scrub removes each named account's opaque browser vault, old GnuPG
directory and passphrase state, legacy `.pgp` backup directory, active sessions,
and only that mailbox's hashed WKD object and manifest entry. It forces the next
browser login through fresh vault generation. It never deletes mail, account
settings, branded assets, unrelated WKD entries, or tunnel configuration.

5. Run the fresh-login acceptance test using the environment file. It performs
the real browser login flow for every named mailbox and fails unless each login
creates and publishes a new browser vault:

```sh
SNAPPYMAIL_CUTOVER_ENV=/absolute/path/to/cutover-users.env npm run test:openpgp:cutover
```

6. Verify the resulting server state, then run the ordinary public deployment
gate:

```sh
npm run openpgp:cutover:verify
npm run verify:openpgp
```

## Acceptance Contract

The cutover browser test uses fresh browser contexts and proves:

1. Each named login creates a new opaque browser vault and public WKD object.
2. Every named account sends a signed and encrypted single-recipient message;
   the recipient and sender's Sent copy decrypt and verify it.
3. A message addressed to all four other named accounts contains every
   recipient's encryption packet; each recipient decrypts and verifies it.
4. A mixed message to `mike.lefler@boompay.ca` and
   `knappcolin04@gmail.com` retains both recipients, prepares one plaintext
   message, and shows a non-blocking plaintext warning. It is never partially
   encrypted and it is never blocked by OpenPGP.

The test writes a non-secret report under `tmp/openpgp-cutover/<run-id>/`.
Do not call the cutover successful until its exit status, the post-login state
verification, and `npm run verify:openpgp` all pass.
