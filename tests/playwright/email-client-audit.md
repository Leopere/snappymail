# Email Client Audit Matrix

This is the pre-fix test contract for the public SnappyMail instances. It uses only
dedicated `snappyqa-*` Mail-in-a-Box accounts. Credentials remain in
`/Users/aedev/.config/codex/snappymail-miab-audit-users.env`, never in this tree
or in audit output.

## Accounts

| Role | BoomPay | nixc / MRC |
| --- | --- | --- |
| Sender and steady-state account | `snappyqa-raw1@boompay.ca` | `snappyqa-raw1@nixc.us` |
| Recipient and bulk-selection account | `snappyqa-raw2@boompay.ca` | `snappyqa-raw2@nixc.us` |
| Fresh-login account | Dedicated account, provisioned only before a bootstrap run | Dedicated account, provisioned only before a bootstrap run |

`npm run test:audit:seed` sends marker-tagged plain test mail to each recipient.
Each subject has a run marker and an individual `action-NN` token so browser
checks can find one exact fixture after a folder move. It is intentionally
separate from browser tests so fixture creation is explicit.
Run it before a selection audit because the Spam fixture deliberately moves audit
mail and changes subsequent Inbox counts.

Focused audit runs use the same report format:

- `npm run test:audit:route` records fresh H2 and forced HTTP/1 browser
  navigation timings. The `:boompay` and `:nixc` forms isolate one canonical
  host.
- `npm run test:audit:accounts` checks the additional-account add/switch workflow.
- `npm run test:audit:bootstrap` is a one-shot test for newly provisioned QA
  accounts; do not rerun it against an already initialized account.
- `npm run test:audit:mailbox` checks reload, free-text search, mark
  read/unread, archive, move, Spam/Not Spam, and Trash using four explicit
  QA fixtures per domain. It restores moved fixtures to Inbox where the UI
  provides a supported move path.
- `npm run test:audit:mailbox:boompay` and `npm run test:audit:mailbox:nixc`
  run that same contract against one public domain when a route outage would
  otherwise obscure the other domain's behavior.
- `npm run test:audit:view` opens a seeded message, checks content and headers,
  inspects the reply/forward action menu, and closes the view without drafting
  or sending mail. The `:boompay` and `:nixc` variants isolate a public host.
- `npm run test:audit:calendar` sends a raw `text/calendar` invitation to
  each QA recipient, screenshots the received attachment, verifies its MIME
  type, calendar file type, VCALENDAR/VEVENT/UID data, and records that opening
  it has no automatic calendar-write side effect.
- `npm run test:audit:caldav` creates one temporary QA calendar event,
  verifies that an overlapping CalDAV time-range query finds it, and deletes it
  in a finally block.
- `npm run test:audit:navigation` checks page changes, sort state, and the
  advanced-search popup submit/clear cycle. Its per-domain variants isolate a
  public host when necessary.
- `npm run test:audit:session` checks the visible account-menu logout path and
  an in-page re-login. Its per-domain variants isolate a public host.
- `npm run test:audit:drafts` creates, saves, confirms, and deletes a unique
  QA draft without sending mail. Its per-domain variants isolate a public host.
- `npm run test:audit:mobile` checks public responsive mailbox and compose states.
- `npm run test:audit:keyboard` checks public shortcut help plus compose CC/BCC shortcuts.
- `npm run test:audit:cross-domain` prepares and sends fresh-account mail in both
  BoomPay-to-nixc and nixc-to-BoomPay directions, asserting two encryption-subkey
  fingerprints before send and decrypted, verified delivery afterward.
- `npm run test:audit:lifecycle:prepare` sends an encrypted pre-rotation QA
  message. The password rotation and verification are deliberately separate so
  the destructive password mutation remains explicit.
- `npm run test:audit:lifecycle:verify` logs in with the rotated QA password and
  requires the pre-rotation message to decrypt and verify with one current key.

## Public Host Baseline

This is an observed deployment baseline, not a request to alter routing during the
client audit.

| Host | Expected role | Observed July 9, 2026 |
| --- | --- | --- |
| `mail.boompay.ca` | Canonical BoomPay webmail host | DNS CNAME and the primary local tunnel are configured. |
| `mail.nixc.us` | Canonical MRC/nixc webmail host | DNS and tunnel registration exist, but it shows the same intermittent no-response behavior as the BoomPay canonical host. |

The tunnel client logged `lookup snappymail: i/o timeout` while connected to
ingress. Direct local requests to `127.0.0.1:8888` and current in-container
lookups of `snappymail` were healthy. The audit retains this as an intermittent
transport/backend-resolution failure until it can be reproduced deterministically.

A twelve-request HTTP/1.1 sample captured one zero-byte timeout followed by
eleven responses in 113-204 ms. Fresh Chromium navigations exhibit the same
intermittent pre-commit timeout, including while `curl` can succeed. This is a
user-facing cold-path failure, not acceptable response latency.

## Confirmed Findings

- Fresh login successfully creates one current server GPG key and keeps the
  login password handling in-browser-free server-managed flow for both brands.
- Cross-domain WKD discovery finds two distinct encryption subkeys in both
  directions, including encrypt-to-self. Both delivered fresh-account messages
  decrypt and verify without armor at the opposite domain. However, both
  cross-domain compose windows wrongly label the recipient as an organization
  recipient.
- Cross-domain sender state is inconsistent: BoomPay alternates between a
  4.25 s successful send and `signing failed: No passphrase given`; nixc
  alternates between a 12.4 s successful send and `Crypt_GPG`
  `stream_select() returned 0`. The latter stack ends in `PGP->signStream`
  during `DoSendMessage`.
- Mobile audits pass layout and compose opening, but MRC currently renders a
  black message editor while BoomPay renders white; long From identities are
  visibly clipped in the mobile compose field.
- A focused BoomPay mailbox run proves reload (1.17 s), exact marker search
  (1.15 s), mark unread/read (89/60 ms), and Archive (65 ms). Delete left the
  selected message in Inbox for 45 seconds. Spam removed the source row in
  84 ms, but opening Spam then reached a visible `Request timed out` state.
  Move To never enters destination mode because a document-level click handler
  clears the state immediately after the toolbar command sets it.
- A fresh Chromium request can time out while a concurrent curl request to the
  same canonical host returns HTTP 200 in under 200 ms. These are recorded as
  separate cold-path failures, not retries or successful UI runs.

## Required Cases

| Area | Browser assertion and evidence | Status |
| --- | --- | --- |
| Public reachability | Fresh Chromium navigation, status, negotiated protocol, and first-byte timing for each canonical public host | Historical baseline failed because both canonical hosts intermittently timed out. Repeated H2 and HTTP/1.1 probes remain a hard audit gate. |
| Branding | Desktop and mobile login/mailbox screenshots show the correct BoomPay or MRC identity | Baseline screenshots captured |
| Login | Login form ready, auth succeeds, mailbox becomes usable, timing recorded | Baseline captured; route failures make it non-deterministic |
| First login | Identity dialog, server GnuPG bootstrap, passphrase capture, and security summary reach Ready without browser password prompts | Passed once on fresh QA accounts: login completed in 3.8-4.0 s, identity save in about 0.55 s, exactly one current server private key, Ready state, and no browser dialog. |
| Mailbox selection | Select page, show the exact all-in-current-view offer, select all, clear selection; repeat in Inbox and Spam | Inbox passes on both brands over H2 and HTTP/1.1; nixc Spam selection passes with 21 messages. BoomPay's Spam move fixture is blocked by a 30-second pending action. |
| Mailbox actions | Reload, free-text search, mark read/unread, archive, move, Spam/Not Spam, and Trash work against uniquely seeded QA mail; every transitional folder state is screenshot captured | BoomPay: reload/search/status/archive pass, Delete stalls for 45 s, Spam folder load times out, and Move To does not activate destination mode. nixc cannot complete a fresh Chromium start consistently enough for this case. |
| Message view | Open a known QA message, render body/header details, expose Reply/Forward/Move To actions, and close cleanly without creating a draft | Both brands pass: BoomPay open 1.34 s, headers 33 ms, menu 28 ms, close 31 ms; nixc open 1.47 s, headers/menu 33 ms, close 27 ms. |
| List navigation | Change page, switch and restore sort, run an advanced subject search, and clear it back to the complete Inbox | BoomPay passes: page change 68/64 ms, sort transitions 1.13/1.19 s, advanced search open 620 ms, and clear 2.10 s. nixc remains subject to fresh-browser route failures. |
| Session | Open the account menu, log out through the user-facing control, return to the login form, and log in again | BoomPay passes: menu 26 ms, logout 850 ms, re-login 3.01 s. nixc remains subject to fresh-browser route failures. |
| Draft lifecycle | Compose a unique QA draft, save it to the server, expose its current UID/error state, and delete it through the confirmation UI | Focused browser case is wired for both domains; results pending a healthy fresh public browser path. |
| Compose | Recipient entry, subject/body, send control, visual compose screenshot, and bounded send timing | Settled compose and visible Security screens are captured; send audit is active |
| Same-domain crypto | Sender signs, recipient set includes sender, recipient decrypts, signature verifies, and Sent never claims a recipient's decrypt result | Failing: latest BoomPay run stopped at `signing failed: No passphrase given`; a prior nixc run stopped at an unusable secret key. The audit now waits for signature settlement before making a verification claim. |
| Cross-domain crypto | WKD lookup, selected encryption subkeys, signed/encrypted send, decrypt, and verify between BoomPay and nixc | Partial: both directions discover two subkeys and recipient copies decrypt/verify when sends complete. Cross-domain policy misclassifies recipients as internal and sender execution is intermittent. |
| Decrypt truth | Decrypted body replaces armor before a success state; missing keys and failures stay explicit | Passing evidence for both cross-domain recipients and a nixc Sent copy: plaintext replaces armor, signatures verify, and the Sent copy makes no remote delivery claim. |
| Account switching | Switching an additional account reaches a mailbox or explicit error inside a bounded timeout | Focused audit passes after settling first-login identity: BoomPay switch 4.42 s; nixc switch 3.18 s; both identity saves about 0.315 s. Strict cold-route reliability remains a separate failing gate. |
| Password/key lifecycle | Login password capture, logout/login decrypt, and password/key rotation preserve old-message decryptability | QA-only prepare and post-rotation verification fixtures are wired; password mutation is explicit and still pending execution. |
| Keyboard, mobile, and accessibility | Compose, shortcuts, selection controls, and text fit are screenshot checked at desktop and mobile sizes | Mobile mailbox/compose passes at 390x844 on both brands without horizontal overflow; nixc keyboard help and Compose Alt+B/Alt+C pass. Visual review still finds MRC's black editor body and clipped long From identity. |

## Acceptance Rules

- Every case records timings, screenshots for visible states, and the underlying
  message/crypto state when applicable.
- A timeout, raw PGP armor after a reported decrypt, a false verification claim,
  or an invisible/blocking popup is a failure in the report, not a passing retry.
- The current configured page size is 20 messages, so 30 seeded fixtures force a
  second page and the all-in-view offer.
- A public route must complete a fresh browser request within two seconds. A later
  fast retry does not erase a failed first request.
- Application behavior is not changed until the relevant scenario is repeatable
  and its current behavior is represented in the audit report.
