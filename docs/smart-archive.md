# Smart Archive

This document records the expected behavior and phased delivery of SnappyMail Smart Archive. The enable switch, conservative folder bootstrap, in-place category suggestions, and curated newsletter delivery rule are implemented. Folder scans, bulk apply, history, and user-trained Sieve rule promotion remain future phases.

## Goal

Smart Archive should help users sort archived and recurring mail into useful buckets without changing the meaning of the normal Archive button or turning SnappyMail into an always-on mail processor. It should be conservative, inspectable, and reversible enough that users can trust it.

The governing rule is:

> Semantic tools suggest; Sieve enforces.

## User Model

Archive remains the fast "done with this" action.

Smart Archive is a separate review and maintenance flow. Its four durable destinations are:

- `Archive.Smart.Finance`
- `Archive.Smart.Newsletters`
- `Archive.Smart.Notifications`
- `Archive.Smart.Security`

Existing servers may instead expose the same hierarchy at the top level as `Smart.Finance`, `Smart.Newsletters`, and so on. Setup must reuse either layout and must never create a duplicate hierarchy merely to normalize its path.

Calendar invitations and contracts stay in Inbox because they usually require action. Development and infrastructure updates are notifications, not separate user jobs. Low-value mail belongs in Notifications, Done, Spam, or Trash rather than a fifth “Discard” concept.

Unknown and low-confidence messages stay visible in their source folder.

## Two-Layer Architecture

### Server rules for obvious future mail

Server-side Sieve is the durable automation layer. It handles deterministic cases even when SnappyMail is closed. Examples include:

- CIBC, receipts, and invoices to `Archive.Smart.Finance`
- KWLUG and other mailing lists to `Archive.Smart.Newsletters`
- Netdata, YouTrack, GitHub, GitLab, OVH, SoyouStart, Cloudflare, and similar automated updates to `Archive.Smart.Notifications`
- Non-expiring password and account-security records to `Archive.Smart.Security`

Authentication codes and login notifications are an exception. SnappyMail
marks them with the retention keywords documented in
`docs/auth-mail-retention.md`. Server sorting must keep those messages out of
Smart Archive so they remain visible until the retention service moves them to
Trash.

These rules should use stable envelope, sender, domain, list, and subject patterns. Sieve remains the source of truth for promoted automation.

The fork may ship a curated deterministic default when it is reversible, only moves mail to a visible subscribed category, and has documented high-risk exclusions. The newsletter default matches `List-Id` or `List-Unsubscribe`, excludes calendar, contract, finance, account-security, and explicit-action subjects, then files into `Smart.Newsletters`. Existing user filters run first. It never marks mail read, deletes, discards, forwards, or rejects.

### SnappyMail as the review and control surface

SnappyMail helps the user inspect unknown mail and train future server behavior. It must not silently invent rules. The initial control surface should provide:

- **Smart Archive scan** on a selected folder
- Dry-run category counts
- Sample messages for each category
- A confidence threshold
- An explicit Apply button
- **Create server rule from this pattern** for accepted recurring senders or patterns

SnappyMail is the trainer and editor, not a fragile background daemon.

The mailbox sidebar exposes only the real server-backed `Smart` hierarchy. It does not repeat the same concepts as virtual category shortcuts. On mobile, `Smart` starts collapsed and opens only when the user asks for it, keeping navigation focused on Inbox and ordinary mail actions.

## Message Flow

```text
Message arrives
  -> Sieve handles known rules immediately
  -> Unknown mail stays visible
  -> SnappyMail classifies and suggests a category
  -> User accepts a move or recurring rule
  -> SnappyMail writes or proposes a Sieve rule
  -> Future matching mail is handled server-side
```

## Classification Signals

Start with message metadata:

- Sender address and domain
- Sender display name
- Envelope recipients and aliases
- Subject phrases
- List headers
- Message flags
- A short server-provided preview when available

Semantic classification is for ambiguous mail, not enforcement. Body text must be skipped for encrypted messages unless the user has already decrypted it locally. Message bodies and private headers must not be uploaded to third-party services by default.

Each suggestion should include enough evidence for review:

```json
{
  "category": "Finance",
  "confidence": 0.95,
  "reason": "invoice_or_payment_terms",
  "signals": ["subject:invoice", "domain:stripe.com"]
}
```

## Safety Contract

- Scans are dry runs by default.
- Semantic classification never moves messages or creates server rules.
- Low-confidence and unknown messages remain in their source folder.
- Applying moves always requires an explicit user action.
- Only suggestions at or above the selected threshold are eligible for a bulk apply. The recommended default threshold is `0.95`.
- Rule promotion is a separate explicit action. Show the proposed match pattern and destination before changing server-side Sieve.
- Curated deterministic defaults are versioned product policy, not semantic rule promotion. They must be idempotent and removable without touching user rules.
- Smart Archive never permanently deletes mail. Low-value automated mail moves to `Archive.Smart.Notifications`; actual junk uses Spam or Trash.
- Authentication-mail retention is separate from Smart Archive. It moves only
  conservatively tagged messages to recoverable Trash after the documented
  delay.
- Failure to classify, move, or promote a rule must leave the message safely in its current location.

For each applied move, retain a manifest entry containing:

- Source folder
- Source UID
- Message-ID
- Target folder
- Category
- Confidence
- Reason and matched signals
- Timestamp

## Delivery Phases

### Phase 1: UX and documentation

- Explain subscribed versus unsubscribed folders.
- Keep `Archive.Smart` folders visible and understandable.
- Provide one enable switch that idempotently reuses or creates and subscribes the standard hierarchy.
- Start the secondary `Smart` hierarchy collapsed on mobile until the user opens it.
- Maintain this document as the product contract.

Folder visibility is separate from Smart Archive classification. When **Hide unsubscribed folders** is enabled, SnappyMail must keep any parent container needed to reach a subscribed descendant, including hierarchies such as `Archive.Smart.Notifications`.

A configured system folder is shown once in the dedicated system section. If it also contains ordinary subscribed folders, its visible descendants remain reachable in the ordinary folder tree without repeating the system folder itself.

A non-selectable container with unread descendants exposes **Mark all subfolders as read**. A fully selected message list exposes **Mark whole folder as read**. Both reuse IMAP's existing seen-flag operation; neither moves, archives, or deletes messages.

### Phase 2: Smart Archive dry run

- Add **Smart Archive scan** to a selected folder.
- Use a metadata-only classifier in SnappyMail or a backend action.
- Show category counts, confidence, evidence, and representative examples.
- Do not move messages or create Sieve rules.

### Phase 3: Apply safe moves

- Require explicit confirmation.
- Move only suggestions at or above the selected confidence threshold.
- Keep the manifest and review history.
- Never delete; route low-value automated mail to `Archive.Smart.Notifications`.

### Phase 4: Promote accepted patterns to rules

- Let the user convert an accepted recurring pattern into a Sieve rule.
- Preview the match conditions and destination before saving.
- Store the rule server-side so it works when SnappyMail is closed.
- Keep semantic classification advisory; deterministic Sieve rules perform future routing.

## Product Notes

Avoid adding controls until they are needed. The first Smart Archive screen needs only the source folder, dry-run results, category samples, confidence threshold, and Apply action. Rule promotion belongs beside an accepted pattern, not in the initial scan controls.

Normal Archive behavior and existing IMAP folder semantics must remain unchanged.

## Current Mailbox Example

The current `colin@nixc.us` mailbox exposes its subscribed hierarchy as:

- `Smart.Finance`
- `Smart.Newsletters`
- `Smart.Notifications`
- `Smart.Security`

Server-side Sieve handles known deterministic future mail, including the managed newsletter default. The SnappyMail scanning, review, apply, and user-trained rule-promotion surfaces described here remain future phases.

Smart Archive defaults to enabled for `colin@nixc.us` and `@boompay.ca` accounts. A saved opt-out always overrides that account default. Enabling it creates and subscribes the standard folders. It does not rescan old mail or move model suggestions. Administrators can apply the versioned deterministic defaults through the project-local `snappymail-smart-sorting` skill; account-specific and model-derived rules still require review.
