# Smart Sorting Policy

## Decision Order

Classify the highest-risk deterministic topics before bulk mail:

1. Calendar invitations
2. Contracts and signature requests
3. Account security
4. Finance and transactions
5. Newsletters and subscriptions
6. Automated notifications
7. Personal or unknown mail

Do not infer that a sender is safe, transactional, or unimportant from a display name or `noreply` address alone.

## Automation Levels

| Signal | Client suggestion | Server rule |
| --- | --- | --- |
| Stable recipient alias, sender, or list header | Yes | Yes |
| Narrow action or transaction subject | Yes | Yes, with review |
| `Auto-Submitted` or standards-based report MIME | Yes | Yes, if destination is visible |
| Model category or body semantics | Yes | No |
| Decrypted private content | Local display only | No |
| Unknown or low confidence | Keep visible | No |

## Newsletter Default

Route to the visible subscribed `Smart.Newsletters` folder when either `List-Id` or `List-Unsubscribe` exists.

Exclude subjects containing signals for:

- calendar invitations, RSVP, or response requests;
- signatures, contracts, agreements, leases, waivers, or NDAs;
- invoices, receipts, payments, amounts due, billing, statements, remittance, purchase orders, refunds, tax documents, or payroll;
- security alerts, unusual or new logins, password changes, two-factor authentication, verification codes, account verification, locks, or suspicious activity;
- explicit action, response, approval, review, confirmation, verification, or reply requests.

Run existing user filters first. The managed default must only `fileinto` the newsletter folder and `stop`; it must not add `\Seen`, discard, redirect, reject, or delete.

`List-Unsubscribe` is intentionally accepted without `Precedence: list`: many genuine newsletters and job digests omit `Precedence`. The high-risk subject exclusions make this safer than treating every bulk header as unimportant.

## Repository Map

- `dev/Classifier/Rules.js`: bounded deterministic metadata classification.
- `dev/Classifier/EmailClassifier.js`: client suggestions and durable category flags.
- `dev/Classifier/SmartArchiveSetup.js`: standard Smart folder hierarchy.
- `dev/Classifier/CategoryFolders.js`: category route discovery and creation.
- `dev/Sieve/`: Sieve editor and serializer.
- `snappymail/v/0.0.0/app/libraries/RainLoop/Providers/Filters/SieveStorage.php`: ManageSieve storage.
- `docs/smart-archive.md`: user and safety contract.
- `tests/security/message-classifier.cjs`: deterministic classifier regression tests.
- `tests/security/smart-archive-setup.cjs`: Smart folder bootstrap regression tests.

## Verification

Check all of the following before declaring a rule live:

- The destination exists and is subscribed.
- The previously active script is still active.
- Every prior rule is byte-present in the candidate after removing only normalized line endings.
- The complete candidate compiles with `sievec`.
- `sievec` writes its second positional argument as a compiled output file; the output is a disposable regular temporary file and is never `/dev/null`, a device node, the source script, or another valuable path.
- Running the patch twice produces the same output.
- A message with `List-Unsubscribe` and an ordinary digest subject routes to Newsletters.
- A list message with an invoice, signature request, security alert, or meeting invitation subject does not match the newsletter default.
- An unrelated personal message does not match.
- No rule marks the message read or performs a destructive action.
