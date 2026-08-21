#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const branding = read('snappymail/v/0.0.0/app/libraries/snappymail/branding.php');
const api = read('snappymail/v/0.0.0/app/libraries/RainLoop/Api.php');
const csp = read('snappymail/v/0.0.0/app/libraries/snappymail/http/csp.php');
const boot = read('dev/boot.js');

assert.match(branding, /'mail\.boompay\.ca' => 'boompay\.ca'/,
	'the canonical BoomPay mail host must report under the boompay.ca Notomo site.');
assert.doesNotMatch(branding, /'webmail\.boompay\.ca'/,
	'the retired webmail.boompay.ca host must not return as a telemetry alias.');
assert.match(branding, /'mail\.nixc\.us' => 'nixc\.us'/,
	'mail.nixc.us must report under its own nixc.us Notomo site.');
assert.match(branding, /'notomoSiteId' => static::notomoSiteId\(\)/,
	'the server-selected site ID must be included in AppData.');

assert.match(boot, /const siteId = !admin && !appData\.Auth && appData\.Brand\?\.notomoSiteId;/,
	'telemetry must run only on the unauthenticated user login shell.');
assert.match(boot, /new URL\('https:\/\/notomo\.colinknapp\.com\/n\.gif'\)/,
	'webmail telemetry must use the one-shot pixel and never start session replay.');
assert.doesNotMatch(boot, /notomo\.colinknapp\.com\/n\.js/,
	'the full Notomo tracker must not be loaded into webmail.');
assert.match(boot, /pixel\.searchParams\.set\('u', page\.origin \+ page\.pathname\)/,
	'analytics must strip query strings and hashes from the reported page URL.');
assert.match(boot, /image\.referrerPolicy = 'no-referrer'/,
	'the browser must not leak the full webmail URL as an HTTP referrer.');

assert.match(api, /\$CSP->add\('img-src', 'https:\/\/notomo\.colinknapp\.com'\)/,
	'CSP must grant Notomo only the image permission required by the pixel.');
assert.doesNotMatch(api, /\$CSP->add\('script-src', 'https:\/\/notomo\.colinknapp\.com'\)/,
	'CSP must not grant Notomo script execution in webmail.');
for (const directive of [
	`'form-action' => ["'self'"]`,
	`'frame-ancestors' => ["'none'"]`,
	`'object-src' => ["'none'"]`
]) {
	assert.ok(csp.includes(directive), `CSP must include ${directive}.`);
}
assert.match(csp, /in_array\("'none'", \$this->directives\['frame-ancestors'\], true\)/,
	'X-Frame-Options must stay aligned with the quoted frame-ancestors source.');

console.log('Notomo login privacy contract checks passed');
