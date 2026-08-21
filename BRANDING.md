# Brandable Fork Notes

This fork keeps upstream SnappyMail attribution and AGPL licensing intact while adding host-aware runtime branding defaults for Motherboard Repair Canada and BoomPay.

## Runtime Env Vars

- `BRAND_HOST_MAP`
- `BRAND_PROFILE`
- `BRAND_ALLOW_THEMES`

If unset, the app maps `mail.boompay.ca` to the BoomPay profile and `mail.nixc.us` to the Motherboard Repair Canada profile. Unknown hosts fall back to MRC. Set `BRAND_HOST_MAP` as semicolon-separated `host=profile` entries, for example `mail.boompay.ca=boompay;mail.nixc.us=mrc`. Set `BRAND_PROFILE=boompay` or `BRAND_PROFILE=mrc` only when one fixed brand should override host detection.

Brand profiles are intentionally authoritative over imported SnappyMail runtime config for title, loading text, favicon, manifest, color variables, and the managed theme. The user theme picker is disabled by default so each host presents one managed brand. Set `BRAND_ALLOW_THEMES=1` only when you deliberately want users to see theme controls again.

## Local Static Loop

Run `npm run dev` to build once, start the local Docker stack on `127.0.0.1:8888`, and keep rebuilding static assets when source, templates, branding code, brand assets, or the managed theme change. Generated static CSS/JS output is ignored by the watcher to avoid rebuild loops.

Run `npm run dev:tunnel` when the local stack should also register the `mail.boompay.ca`, `mail.nixc.us`, `openpgpkey.boompay.ca`, and `openpgpkey.nixc.us` reverse tunnels through `ingress.nixc.us`. Copy `.env.example` to `.env` locally and set `TUNNEL_KEY_PATH` to the private tunnel key before starting the tunnel profile. The `.env` file is ignored by git.

The test and dev helpers do not force-recreate public tunnel client sidecars. Running tunnel clients are left untouched after SnappyMail rebuilds; new tunnel hostnames are only registered when the tunnel profile is explicitly started.

## Internal GnuPG Defaults

OpenPGP and GnuPG are enabled by default when supported. For same-domain recipients, compose automatically requires GnuPG signing and individual encryption once every recipient has a usable key. The local Playwright provisioning creates two `example.com` test users and exchanges their public keys without modifying imported production domains.
