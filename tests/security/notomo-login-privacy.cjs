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
const reporter = boot.slice(boot.indexOf('installNotomoErrorReporter'), boot.indexOf('\n\t};\n\ntry {'));

assert.match(branding, /'mail\.boompay\.ca' => 'boompay\.ca'/,
	'the canonical BoomPay mail host must report under the boompay.ca Notomo site.');
assert.doesNotMatch(branding, /'webmail\.boompay\.ca'/,
	'the retired webmail.boompay.ca host must not return as a telemetry alias.');
assert.match(branding, /'mail\.nixc\.us' => 'nixc\.us'/,
	'mail.nixc.us must report under its own nixc.us Notomo site.');
assert.match(branding, /'notomoSiteId' => static::notomoSiteId\(\)/,
	'the server-selected site ID must be included in AppData.');

assert.match(boot, /const siteId = !admin && appData\.Brand\?\.notomoSiteId/,
	'telemetry must cover authenticated and unauthenticated user shells, but not admin.');
assert.match(boot, /endpoint = 'https:\/\/notomo\.colinknapp\.com\/collect'/,
	'webmail must send only local error reports to the Notomo collector.');
assert.doesNotMatch(boot, /notomo\.colinknapp\.com\/n\.js|n-rrweb|n-config/,
	'webmail must never load remote Notomo code, configuration, or replay assets.');
assert.match(boot, /credentials: 'omit'/,
	'error reports must not send ambient credentials.');
assert.match(boot, /referrerPolicy: 'no-referrer'/,
	'error reports must not leak the webmail URL in a referrer.');
assert.match(boot, /seen\.size >= 25/,
	'error reporting must have a bounded per-page budget.');
for (const sensitiveField of ['message:', 'stack:', 'title:', 'referrer:', 'document_uri:', 'request_url:']) {
	assert.ok(!reporter.includes(sensitiveField), `error reports must exclude ${sensitiveField}`);
}

assert.match(api, /\$CSP->add\('connect-src', 'https:\/\/notomo\.colinknapp\.com'\)/,
	'CSP must allow only local error reports to reach Notomo.');
assert.doesNotMatch(api, /\$CSP->add\('script-src', 'https:\/\/notomo\.colinknapp\.com'\)/,
	'CSP must not allow remote Notomo code to run in webmail.');
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
