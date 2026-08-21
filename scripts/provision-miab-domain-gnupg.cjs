#!/usr/bin/env node

console.error(
	'Server-side GnuPG provisioning is retired for this browser-vault deployment. '
	+ 'It would violate the browser-only private-key boundary. Use npm run openpgp:cutover:plan instead.'
);
process.exitCode = 2;
