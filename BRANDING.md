# Brandable Fork Notes

This fork keeps upstream SnappyMail attribution and AGPL licensing intact while adding runtime branding defaults for Motherboard Repair Canada.

## Runtime Env Vars

- `BRAND_NAME`
- `BRAND_SHORT_NAME`
- `BRAND_DESCRIPTION`
- `BRAND_PRIMARY_COLOR`
- `BRAND_SECONDARY_COLOR`
- `BRAND_THEME_COLOR`
- `BRAND_THEME_NAME`
- `BRAND_FAVICON_URL`
- `BRAND_LOGO_URL`
- `BRAND_MANIFEST_ICON_URL`
- `BRAND_ALLOW_THEMES`

If unset, the app defaults to the Motherboard Repair Canada assets committed under `snappymail/v/0.0.0/static/brand`.
Brand env vars are intentionally authoritative over imported SnappyMail runtime config for title, loading text, favicon, manifest, color variables, and the managed theme. The default theme is `MotherboardRepairCanada`, and the user theme picker is disabled by default so the app presents one managed brand. Set `BRAND_ALLOW_THEMES=1` only when you deliberately want users to see theme controls again.

## Local Static Loop

Run `npm run dev` to build once, start the local Docker stack on `0.0.0.0:8888`, and keep rebuilding static assets when source, templates, branding code, brand assets, or the managed theme change. Generated static CSS/JS output is ignored by the watcher to avoid rebuild loops.

Run `npm run dev:tunnel` when the local stack should also register the `mail.nixc.us` reverse tunnel through `ingress.nixc.us`. Copy `.env.example` to `.env` locally and set `TUNNEL_KEY_PATH` to the private tunnel key before starting the tunnel profile. The `.env` file is ignored by git.

The test and dev scripts recreate `tunnel-client` after SnappyMail is rebuilt so the sidecar keeps sharing the current SnappyMail container network namespace.

## Internal GnuPG Defaults

OpenPGP and GnuPG are enabled by default when supported. For same-domain recipients, compose automatically requires GnuPG signing and individual encryption once every recipient has a usable key. The local Playwright provisioning creates two `example.com` test users and exchanges their public keys without modifying imported production domains.
