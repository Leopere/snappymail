# SnappyMail Public Client Audit

Audit date: July 9-10, 2026

This report records the current public behavior before product fixes. All mail
activity used only dedicated `snappyqa-*` Mail-in-a-Box accounts. No real user
mailboxes, keys, or tunnel configuration were changed during the audit.

## Scope

- BoomPay: `https://mail.boompay.ca`
- MRC/nixc: `https://mail.nixc.us`
- First login, key bootstrap, account switching, inbox selection, bulk Spam,
  mailbox actions, message view, list navigation, session recovery, mobile,
  keyboard shortcuts, same-domain and cross-domain OpenPGP behavior, Sent-copy
  truth, and password-rotation preparation.

The repeatable harness and case matrix are in
[`tests/playwright/snappymail-audit.spec.cjs`](../tests/playwright/snappymail-audit.spec.cjs)
and [`tests/playwright/email-client-audit.md`](../tests/playwright/email-client-audit.md).

## Verified

- Fresh QA login generates exactly one current server GPG private key per
  account, reaches a visible `Ready` security state, and does not show a native
  browser password prompt. Evidence:
  [`bootstrap report`](../tmp/email-client-audit/2026-07-09T23-10-41-556Z/report.md).
- Additional account switching works after the first-login Identity dialog is
  settled. BoomPay switched in 4.42 seconds; nixc switched in 3.18 seconds.
  Evidence: [`account report`](../tmp/email-client-audit/2026-07-09T23-05-08-024Z/report.md).
- Inbox selection correctly offers current-page selection followed by all
  messages in the current view. The proof covers both brands and both H2 and
  HTTP/1.1 under a healthy route.
- nixc Spam selection supports all 21 messages in the view.
- Mobile mailbox and compose checks pass at 390x844 without page-width
  overflow. Compose opened in roughly 270 ms on both brands. Evidence:
  [`mobile report`](../tmp/email-client-audit/2026-07-09T23-17-42-047Z/report.md).
- nixc keyboard help and Compose Alt+B/Alt+C recipient shortcuts pass. The
  BoomPay counterpart remains subject to route availability.
- WKD discovery and recipient selection work both directions for fresh
  BoomPay/nixc accounts: each prepared plan contains two distinct encryption
  subkey fingerprints, including encrypt-to-self.
- Delivered fresh cross-domain mail decrypts and verifies at the opposite
  domain without raw PGP armor. Evidence:
  [`BoomPay to nixc`](../tmp/email-client-audit/cross-receive-boompay-to-nixc.png)
  and [`nixc to BoomPay`](../tmp/email-client-audit/cross-receive-nixc-to-boompay.png).
- A successful Sent copy is locally decrypted and verified without claiming
  remote delivery or recipient decryption. This is correct encrypt-to-self
  behavior, not evidence that a recipient opened the mail.
- Focused BoomPay mailbox behavior is repeatable for reload (1.17 seconds),
  marker search (1.15 seconds), mark unread/read (89/60 ms), and Archive
  (65 ms). Evidence:
  [`mailbox action report`](../tmp/email-client-audit/2026-07-10T00-12-50-320Z/report.md).
- BoomPay list navigation passes with reviewed screenshots: page two/one in
  68/64 ms, Subject sort and restore in 1.13/1.19 seconds, advanced search in
  620 ms, and clear in 2.10 seconds. Evidence:
  [`navigation report`](../tmp/email-client-audit/2026-07-10T00-27-27-783Z/report.md),
  [`page two`](../tmp/email-client-audit/2026-07-10T00-27-27-783Z/list-navigation-boompay-b-page-two.png),
  [`advanced search`](../tmp/email-client-audit/2026-07-10T00-27-27-783Z/list-navigation-boompay-b-advanced-search.png),
  and [`advanced results`](../tmp/email-client-audit/2026-07-10T00-27-27-783Z/list-navigation-boompay-b-advanced-results.png).
- BoomPay session recovery passes with reviewed user-facing states: account
  menu open in 26 ms, Logout in 850 ms, and re-login in 3.01 seconds. Evidence:
  [`session report`](../tmp/email-client-audit/2026-07-10T00-30-31-798Z/report.md),
  [`account menu`](../tmp/email-client-audit/2026-07-10T00-30-31-798Z/session-boompay-b-account-menu.png),
  [`logged out`](../tmp/email-client-audit/2026-07-10T00-30-31-798Z/session-boompay-b-logged-out.png),
  and [`re-logged in`](../tmp/email-client-audit/2026-07-10T00-30-31-798Z/session-boompay-b-relogged-in.png).
- BoomPay message reading passes with reviewed body, full-header, and action-menu
  states: opening a fixture took 1.34 seconds, headers 33 ms, menu 28 ms, and
  close 31 ms. Evidence:
  [`message view report`](../tmp/email-client-audit/2026-07-10T00-37-04-853Z/report.md),
  [`opened message`](../tmp/email-client-audit/2026-07-10T00-37-04-853Z/message-view-boompay-b-opened.png),
  [`full headers`](../tmp/email-client-audit/2026-07-10T00-37-04-853Z/message-view-boompay-b-full-headers.png),
  and [`actions menu`](../tmp/email-client-audit/2026-07-10T00-37-04-853Z/message-view-boompay-b-actions-menu.png).
- The same message-view contract also passes on nixc: open 1.47 seconds,
  headers/menu 33 ms, close 27 ms. Evidence:
  [`nixc message view report`](../tmp/email-client-audit/2026-07-10T00-43-44-580Z/report.md),
  [`opened nixc message`](../tmp/email-client-audit/2026-07-10T00-43-44-580Z/message-view-nixc-b-opened.png),
  and [`nixc actions menu`](../tmp/email-client-audit/2026-07-10T00-43-44-580Z/message-view-nixc-b-actions-menu.png).

## Blocking Failures

1. Both canonical public hosts intermittently accept a TLS connection but do
   not return an HTTP response to a fresh browser request. Later requests can
   complete in about 80-200 ms. This prevents reliable login, send, receive,
   mobile, and account workflows. The local app responds quickly and the
   tunnel routes remain registered, so the exact stale-path cause is still
   unresolved. No tunnel has been restarted or reconfigured during this audit.

2. Cross-domain recipients are incorrectly classified as organization
   recipients. The compose state has `internalReady: true` with only the sender
   in its internal recipient set, and it displays the organization-encryption
   notice for `boompay.ca` to `nixc.us` and vice versa. The audit now fails this
   condition explicitly.

4. Server-side GPG sending is intermittent even with a valid prepared key plan.
   Observed outcomes include `signing failed: No passphrase given`, a 60-second
   pending send, and `Crypt_GPG stream_select() returned 0` in `PGP->signStream`.
   Successful sends have taken 4.25 seconds and 12.37 seconds, both above the
   intended responsiveness target.

5. BoomPay batch move-to-Spam remains pending after 30 seconds. nixc completed
   the analogous one-message fixture move and all-in-Spam selection.

6. Visual review: MRC's compose editor body renders black while BoomPay's is
   white, and long From identities are clipped in the mobile compose field.

7. Password-rotation verification has not started because its pre-rotation
   encrypted self-message could not complete: BoomPay remained sending for 60
   seconds and nixc hit the public-route timeout. No QA password has been
   rotated. Evidence: [`lifecycle preparation report`](../tmp/email-client-audit/2026-07-09T23-43-00-927Z/report.md).

8. Focused mailbox actions expose three additional failures on BoomPay. Delete
   leaves the selected QA message in Inbox for 45 seconds; Spam removes the
   source row but opening Spam reaches a visible `Request timed out` error; and
   Move To never enters destination mode. The last condition is traceable to
   the mailbox screen's document click handler clearing move state after the
   toolbar command sets it. Evidence:
   [`action report`](../tmp/email-client-audit/2026-07-10T00-12-50-320Z/report.md),
   [`Trash state`](../tmp/email-client-audit/2026-07-10T00-12-50-320Z/mailbox-actions-boompay-b-trash-error.png),
   [`Spam state`](../tmp/email-client-audit/2026-07-10T00-12-50-320Z/mailbox-actions-boompay-b-spam-error.png),
   and [`Move To state`](../tmp/email-client-audit/2026-07-10T00-12-50-320Z/mailbox-actions-boompay-b-move-error.png).

9. Canonical host reliability is a cold-browser failure, not simply a slow
   endpoint. Immediately before a nixc-only browser audit, curl completed in
   129 ms; the fresh Chromium navigation then waited 20 seconds without an HTTP
   response. The analogous BoomPay-only run shows the same pattern. Evidence:
   [`nixc route failure`](../tmp/email-client-audit/2026-07-10T00-19-47-399Z/report.md)
   and [`BoomPay route failure`](../tmp/email-client-audit/2026-07-10T00-17-35-576Z/report.md).

10. PGP-bearing message reads can fail before a body reaches the browser. The
    live app log records `CantGetMessage[202] Unable to lock GnuPG keyring` for
    both BoomPay `INBOX` and `Sent`. The failing path is
    `MailSo\\Mail\\Message::fromFetchResponse` calling
    `GPG->getEncryptedMessageKeys` while parsing a message, which waits on the
    same account keyring lock used by sign/decrypt work. This is distinct from
    IMAP availability and must remain a dedicated negative regression case
    until fetching a message no longer depends on a free GnuPG lock.

11. The inspected public origin is not source-identical to this checkout. The
    running `snappymail-snappymail-1` container mounts
    `/Users/aedev/dev/snappymail/snappymail`, while the audit source tree is
    `/Volumes/macmini dump/Dev/snappymail`; existing tunnel clients and the
    live app therefore need explicit source/build attribution before a product
    fix can be claimed as deployed. No tunnel was restarted or reconfigured to
    collect this evidence.

## Useful Runs

- `npm run test:audit`: full strict suite. It intentionally fails on any real
  behavior failure but always writes a report and screenshots.
- `npm run test:audit:route`: fresh H2 and forced HTTP/1 public-route probes;
  `:boompay` and `:nixc` isolate a canonical host.
- `npm run test:audit:accounts`: focused additional-account flow.
- `npm run test:audit:bootstrap`: one-time first-login lifecycle check.
- `npm run test:audit:mobile`: responsive mailbox and compose states.
- `npm run test:audit:mailbox`: standard action workflow across both domains.
- `npm run test:audit:mailbox:boompay` and `npm run test:audit:mailbox:nixc`:
  repeat that contract independently when the other public host is unhealthy.
- `npm run test:audit:view`: message body, headers, actions menu, and close.
- `npm run test:audit:navigation`: pagination, sorting, and advanced search.
- `npm run test:audit:session`: menu logout and re-login.
- `npm run test:audit:keyboard`: shortcut help and Compose recipient shortcuts.
- `npm run test:audit:cross-domain`: WKD discovery, send, recipient decrypt,
  verification, and Sent-copy truth.
- `npm run test:audit:lifecycle:prepare`: prepares the encrypted QA message
  required before an explicit password-rotation test.

## Change Boundary

The work so far adds audit fixtures, screenshots, QA accounts, and reporting.
It does not change product behavior, restart tunnels, alter DNS, or remove any
existing key or message data. Product fixes should begin only from these
reproducible failures and should keep the corresponding focused audit green.
