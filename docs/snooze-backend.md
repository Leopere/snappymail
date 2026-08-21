# Snooze backend boundary

Snooze records are stored in SnappyMail's existing local account-scoped private
storage. A record contains IMAP folder names, UIDVALIDITY values, source and
destination UIDs, Message-IDs, wake time, and lifecycle state. It never
contains an IMAP or SMTP password.

Authenticated JSON actions:

- `SnoozeCreate`: `folder`, `uid` (or an explicit comma-separated `uids` set),
  and Unix `wakeAt`. The server expands a seed UID with IMAP THREAD when the
  server supports it and moves the whole conversation into subscribed folder
  `Snoozed`.
- `SnoozeList`: lists records belonging to the authenticated account.
- `SnoozeCancel`: `id`; restores that record immediately without a reminder.
- `SnoozeProcessDue`: claims and restores up to 20 due records. Each restored
  record exposes a relative `deepLink` wake event. While the authenticated
  session is available, it also sends an auto-generated, thread-linked message
  from the user's own address to that same address. SMTP's ambiguous delivery
  result is treated as at-most-once and never retried automatically.

`SnoozeProcessDue` is intentionally opportunistic: call it on authenticated
application startup and normal mailbox refresh. A truly unattended scheduler
cannot be added safely inside this web process because recreating an arbitrary
mailbox session would require storing users' mailbox passwords. The production
worker boundary must instead be supplied by Mail-in-a-Box/Dovecot as a narrowly
scoped service mechanism that can move messages only for the named account, or
by a server-side Dovecot plugin/event hook. Once that exists, the worker should
claim the same journal records and invoke the same restore contract; do not add
a shared master mailbox password to SnappyMail.
