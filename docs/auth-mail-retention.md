# Authentication-mail retention

Copyright © 2026 ColinKnapp.com. All rights reserved.

SnappyMail uses conservative deterministic subject rules to mark short-lived
authentication mail. It keeps the public `Account alerts` category and adds a
separate IMAP keyword that a Dovecot-owned retention job can enforce:

- `$smret-auth-code`: authentication and verification codes; move to Trash
  after one day.
- `$smret-security-alert`: login and account-security notifications; move to
  Trash after 30 days.

These reserved keywords are not ordinary user tags. The local MiniLM classifier
cannot create them. Automatic classification writes the category, automatic
provenance, and retention keyword together, but it never moves or archives a
message. A manual category correction removes automatic retention metadata.

## Mail-server boundary

The tracked files in `deploy/mail-retention` belong on the Mail-in-a-Box host,
not in the SnappyMail web container. The allowlist currently admits only
`gmailarchive@nixc.us`. Install them through the tracked Mail-in-a-Box
deployment as follows:

- `nixc-mail-retention` to `/usr/local/libexec/nixc-mail-retention`, owned by
  root and executable.
- `users` to `/etc/nixc-mail-retention/users`, owned by root and not writable
  by the web process.
- The service and timer to `/etc/systemd/system/`, followed by a daemon reload
  and enabling `nixc-mail-retention.timer`.

The hourly job uses `doveadm move`. It searches only Inbox and visible archive
hierarchies, uses the message saved date, and moves matching mail to Trash. It
never expunges or permanently deletes mail. Existing Trash retention remains a
separate policy.

## Acceptance

On a non-production mailbox, deliver old and new fixtures with each retention
keyword plus untagged controls. Run the service and confirm:

1. An auth-code fixture older than one day moves to Trash; a newer one stays.
2. A security-alert fixture older than 30 days moves; a newer one stays.
3. Untagged messages and tagged messages in Spam, Junk, Sent, Drafts, and Trash
   do not move.
4. Messages remain recoverable in Trash and no expunge occurs.
5. The service journal contains no Dovecot errors.

Do not install this job in nginx, PHP-FPM, or the SnappyMail container. Those
processes do not own Dovecot mailboxes and must not receive mailbox passwords
or shell access.
