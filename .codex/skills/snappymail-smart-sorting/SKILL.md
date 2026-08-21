---
name: snappymail-smart-sorting
description: Audit SnappyMail mailboxes, classify recurring mail patterns, and create conservative server-side Sieve filters without deleting mail or overwriting existing rules. Use for Smart Archive categories, newsletter sorting, mailbox triage, default filter policy, category folders, Sieve promotion, or account-specific sorting such as colin@nixc.us.
---

# SnappyMail Smart Sorting

Turn repeatable message metadata into inspectable, always-on Sieve rules. Keep semantic classification advisory; automate only deterministic patterns.

## Workflow

1. Read [references/policy.md](references/policy.md).
2. Inspect the current category code, folder routes, documentation, tests, mailbox folders, and active Sieve script. Never assume the active script is named `rainloop.user`.
3. Count and sample only the headers needed to understand the pattern. Prefer `List-Id`, `List-Unsubscribe`, `Precedence`, `Auto-Submitted`, sender, recipient, and subject over message bodies.
4. Decide whether the pattern is deterministic enough for delivery-time automation:
   - Use Sieve for stable headers, recipients, senders, and narrow subject phrases.
   - Keep body semantics, model predictions, and ambiguous senders as suggestions.
5. Reuse or create a visible subscribed destination. Never route a default rule to Trash, Junk, or a hidden folder.
6. Patch the active script with `scripts/newsletter-sieve.mjs` or an equally bounded category-specific generator. Preserve existing rules and let them run before managed defaults.
7. Compile the complete candidate script with the server's `sievec` before saving it. Treat the second positional argument as a replaced output file, never as an output sink.
8. Save through ManageSieve or `doveadm sieve put`, preserve the active script name, and verify the installed body and folder subscription.
9. Test positive, excluded, and unrelated messages. Confirm the rule does not mark mail read, discard it, redirect it, reject it, or affect existing rules.
10. Update product setup, tests, and `docs/smart-archive.md` when the policy should ship with the fork rather than remain mailbox-specific.

## Safe `sievec` Compilation

Never pass `/dev/null`, another device node, the source script, or any valuable existing path as `sievec`'s output argument. `sievec INPUT OUTPUT` atomically replaces `OUTPUT` with a compiled Sieve file; `/dev/null` is not a shell-style discard target in that position.

Use a dedicated temporary output and remove it afterward:

```sh
candidate=$(mktemp)
compiled=$(mktemp)
trap 'rm -f "$candidate" "$compiled"' EXIT
# Populate "$candidate" first.
sievec "$candidate" "$compiled"
```

Prefer `scripts/install-newsletter-sieve.mjs` to ad hoc remote compilation. Refuse any proposed `sievec` command whose output path is under `/dev`.

## Newsletter Default

Use `Smart.Newsletters` for the current Smart Archive hierarchy. Match `List-Id` or `List-Unsubscribe`, but exclude subjects that indicate calendar invitations, contracts, finance, account security, or explicit action.

Render a standalone managed script:

```sh
node .codex/skills/snappymail-smart-sorting/scripts/newsletter-sieve.mjs render Smart.Newsletters
```

Patch an existing script from standard input:

```sh
node .codex/skills/snappymail-smart-sorting/scripts/newsletter-sieve.mjs patch Smart.Newsletters < current.sieve > candidate.sieve
```

Remove only the managed newsletter blocks:

```sh
node .codex/skills/snappymail-smart-sorting/scripts/newsletter-sieve.mjs remove < current.sieve > candidate.sieve
```

Treat generated output as a candidate until it compiles. Do not write temporary scripts, backups, credentials, or sampled mailbox content into the repository.

Audit and compile against a Mail-in-a-Box host without changing it:

```sh
node .codex/skills/snappymail-smart-sorting/scripts/install-newsletter-sieve.mjs \
  --host box.p.nixc.us --user colin@nixc.us
```

Repeat with `--apply` only after the dry run reports the newsletter match and all exclusions. The installer uses one SSH connection, backs up the active script under `/root/snappymail-sieve-backups`, preserves its name and activation, creates/subscribes the destination, installs through `doveadm sieve put`, and verifies the installed hash.

## Mailbox Operations

Before changing a live mailbox, capture:

- the subscribed folder list;
- all Sieve script names and which one is active;
- the complete active script;
- a restorable copy outside the repository.

For Mail-in-a-Box, prefer the authenticated user's ManageSieve path when working through the app. Administrative maintenance may use `doveadm mailbox` and `doveadm sieve` over SSH. `doveadm sieve put` validates before storing, but still run `sievec` against the full candidate first and compare the installed script afterward.

For `colin@nixc.us`, the known hierarchy is top-level `Smart.*`; verify it each time. Existing hand-written filters are authoritative and must remain ahead of managed defaults.

## Product Contract

Keep these boundaries:

- Server-side rules work while webmail is closed.
- Curated deterministic defaults may ship enabled when they only move mail to visible category folders and have documented exclusions.
- Semantic or model-derived rules require review before server promotion.
- User rules outrank managed defaults.
- Default rules never delete, discard, forward, reject, mark read, or inspect decrypted bodies.
- Re-running setup is idempotent.
- Disabling a product-level default must remove its managed block without touching user rules.
