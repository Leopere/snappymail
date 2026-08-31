# Agent Skills

This repository carries repo-local Codex skills under `.codex/skills/` for behavior that future agents should not rediscover from scratch.

## OpenPGP WKD And Browser Vault

Use `.codex/skills/openpgp-wkd-gnupg/SKILL.md` when changing OpenPGP WKD discovery, hashed public-key publication, browser-vault lifecycle, or public WKD routing. Use `.codex/skills/snappymail-send-encryption-contract/SKILL.md` for compose/send behavior and `.codex/skills/snappymail-decrypt-status-truth/SKILL.md` for decrypt, verify, and forwarding behavior.

For independent encrypted delivery or an end-to-end decryption challenge, follow
`.codex/skills/openpgp-wkd-gnupg/references/one-shot-delivery.md`. It keeps HTTPS
WKD separate from RFC 7929 DNS `OPENPGPKEY` and uses the fixed restricted
`one-shot-tally` mail path. Normal delivery preserves the exact requested body;
the returned-token commitment path is reserved for an explicitly requested
decryption proof.

WKD is the standards-compatible public key discovery surface; private keys and OpenPGP operations remain in the browser vault. The detailed notes are `docs/openpgp-wkd.md`, `docs/openpgp-browser-vault.md`, and `docs/openpgp-verification.md`. An OpenPGP change is not complete until `npm run verify:openpgp` passes.
