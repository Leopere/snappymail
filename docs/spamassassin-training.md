# SpamAssassin training contract

Copyright © 2026 ColinKnapp.com. All rights reserved.

SnappyMail signals that a message is spam or ham. The mail server must consume
that signal and run SpamAssassin training. SnappyMail must not get shell access,
SpamAssassin database access, or a second direct training path.

## What SnappyMail guarantees

When you mark a message as spam, SnappyMail:

1. Uses the account's configured spam folder.
2. Sends `learning=SPAM` with the move request.
3. Sets the IMAP `$Junk` keyword and clears `$NotJunk`.
4. Moves the message with native IMAP `MOVE` when the server supports it.

When you move a message from the configured spam folder to Inbox, SnappyMail:

1. Sends `learning=HAM` with the move request.
2. Sets the IMAP `$NotJunk` keyword and clears `$Junk`.
3. Moves the message to Inbox.

Moving a message from spam to Trash or another folder is not ham training. The
regression test in `tests/security/spam-learning-contract.cjs` protects this
client contract.

## What Mail-in-a-Box must guarantee

Dovecot must use IMAPSieve to train the same SpamAssassin Bayes database used by
inbound filtering. The server integration must:

- Run spam training when a message enters the configured spam folder.
- Run ham training only when a message leaves that folder for Inbox.
- Handle native IMAP `MOVE` as well as copy-and-delete clients.
- Watch the exact configured folder name. Watch both `Spam` and `Junk` if either
  name can be assigned to an account.
- Run `sa-learn` as the same service account and with the same database settings
  used by SpamAssassin during delivery.
- Log handler failures so a successful folder move can't hide failed training.

Don't disable the IMAP `MOVE` capability to work around a server hook. Don't
give the SnappyMail PHP process SSH access or direct access to the Bayes
database. Those approaches weaken the client or create two training paths while
leaving other IMAP clients broken.

Mail-in-a-Box v76 still uses the older `dovecot-antispam` hook. That hook can
miss native IMAP `MOVE`, and its folder-name matching may not match SnappyMail's
configured `Junk` folder. Track the upstream
[IMAP MOVE issue](https://github.com/mail-in-a-box/mailinabox/issues/2570) and
[IMAPSieve change](https://github.com/mail-in-a-box/mailinabox/pull/2571). The
server-side fix belongs in the Mail-in-a-Box deployment, not this repository.

## Live acceptance test

Run this test after every mail-server hook change:

1. Confirm SnappyMail's configured spam folder is one of the folders watched by
   IMAPSieve.
2. Deliver a unique test message to Inbox and record the SpamAssassin `nspam`
   and `nham` Bayes counters. Read the counters with `sa-learn --dump magic`
   under the same service account and database configuration used in delivery.
3. In SnappyMail, mark the message as spam. Confirm that it moved to the spam
   folder, has `$Junk` but not `$NotJunk`, and increased `nspam` by one.
4. In SnappyMail, mark the same message as not spam. Confirm that it moved to
   Inbox, has `$NotJunk` but not `$Junk`, and reclassified the learned message as
   ham. Verify the expected Bayes counter change for the installed SpamAssassin
   version.
5. Move a second message from spam to Trash. Confirm that `nham` did not change.
6. Check Dovecot, IMAPSieve, and training-handler logs. Any handler error fails
   acceptance even if the message moved successfully.

The browser action, IMAP keywords, folder placement, Bayes counters, and clean
server logs must all pass. A successful SnappyMail request by itself does not
prove that SpamAssassin learned the message.
