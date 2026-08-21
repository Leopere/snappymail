---
name: snappymail-public-instance-routing
description: "Use when deploying or debugging branded SnappyMail public instances, Cloudflare/tunnel routing, BoomPay/MRC/nixc host separation, static asset cache-busting, or public WKD host verification."
---

# SnappyMail Public Instance Routing

## Purpose

Each public SnappyMail instance may run the same code, but it must present the correct host identity, brand assets, cache-busted bundle, and WKD surface for that host. BoomPay, MRC, and nixc are separate public products, not one generic UI with a theme accidentally leaking across domains.

## Contract

Before declaring a public node healthy, verify the root app response, AppData static asset version, `static/js/min/libs.min.js`, theme or branding config, favicon/manifest assets, login screen layout, and at least one advanced WKD URL with the original public host preserved. Do not change or restart Cloudflare tunnels casually when other routes are working; first inspect whether the problem is host routing, origin response, cache state, app config, or generated static assets. A fixed deployment means the branded host and `openpgpkey.<domain>` agree on current public keys and the UI loaded by the user is the current bundle.

## Code Map

Branding and app data are served from the SnappyMail app under `snappymail/v/0.0.0/`. Cache-busting and static bundle references run through `snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php`. WKD routes are handled by `snappymail/v/0.0.0/app/libraries/RainLoop/Service.php` and `ServiceActions.php`. Public deployment checks often involve the adjacent branded sites `../boompay-ca`, `../boopay-ca`, and `../nixc-us`; inspect the actual repo names before editing paths.
