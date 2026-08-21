#!/usr/bin/env node

console.error(
	'Server-side GnuPG provisioning is retired for this browser-vault deployment. '
	+ 'It would violate the browser-only private-key boundary. Use the automatic browser-vault migration instead.'
);
process.exitCode = 2;
