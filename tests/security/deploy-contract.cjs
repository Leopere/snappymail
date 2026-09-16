#!/usr/bin/env node
// Copyright © 2026 ColinKnapp.com. All rights reserved.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('.deploy-it.json'));
const deploy = read('scripts/deploy-production.sh');
const dockerfile = read('.docker/release/Dockerfile');
const entrypoint = read('.docker/release/files/entrypoint.sh');
const shipping = JSON.parse(read('.ship-it.json'));
assert.deepStrictEqual(shipping, {
	version: 1,
	delivery: 'local',
	verification: { command: ['./scripts/verify.sh'], timeout_seconds: 1800 }
});
assert(fs.statSync(path.join(root, 'scripts/verify.sh')).mode & 0o111,
	'The hook verification command must be executable.');

assert.deepStrictEqual(manifest, {
	version: 1,
	after_ship: true,
	environment: 'production',
	timeout_seconds: 1800,
	command: ['./scripts/deploy-production.sh'],
	env: []
});
const handoff = read('scripts/jenkins-release.py');
assert(deploy.includes('jenkins-release.py'), 'Production delivery must use the Jenkins handoff.');
assert(!deploy.includes('docker buildx build'), 'Jenkins owns the release build.');
assert(!deploy.includes('ship_it_bin'), 'Delivery must not trigger separate infrastructure releases.');
for (const required of ['EXPECTED_REVISION', 'mail.boompay.ca', 'mail.nixc.us', 'accepted.json']) {
	assert(handoff.includes(required), `Missing coordinated deployment contract: ${required}`);
}
assert(dockerfile.includes('ARG SOURCE_REVISION'));
assert(dockerfile.includes('LABEL org.opencontainers.image.revision="$SOURCE_REVISION"'));
assert(dockerfile.includes('chown www-data:www-data /snappymail'));
assert(dockerfile.includes('chmod 550 /snappymail'));
assert(dockerfile.includes(
	'COPY --chown=root:root deploy/snappymail-domains/boompay.ca.json /opt/snappymail-domains/boompay.ca.json'
));
assert(entrypoint.includes('MANAGED_BOOMPAY_DOMAIN=/opt/snappymail-domains/boompay.ca.json'));
assert(entrypoint.includes('readlink -f "$SNAPPYMAIL_DOMAIN_PARENT"'));
assert(entrypoint.includes('[ -L "$SNAPPYMAIL_DOMAIN_DIR" ]'));
assert(entrypoint.includes('mktemp -d /tmp/snappymail-managed-domain.XXXXXX'));
assert(entrypoint.includes('mv -fT "$SNAPPYMAIL_DOMAIN_STAGE/boompay.ca.json" "$SNAPPYMAIL_BOOMPAY_DOMAIN"'));
assert(!entrypoint.includes('SNAPPYMAIL_BOOMPAY_DOMAIN_NEW'),
	'The root entrypoint must not stage files at predictable paths in a web-writable directory.');
for (const traversable of ['/etc', '/etc/nginx', '/usr', '/usr/local', '/usr/local/etc', '/usr/local/etc/php-fpm.d']) {
	assert.match(
		dockerfile,
		new RegExp(`chmod 755[\\s\\S]*${traversable.replaceAll('/', '\\/')}`),
		`The release image must keep ${traversable} traversable by FPM workers.`
	);
}
assert(
	dockerfile.indexOf('chown www-data:www-data /snappymail') >
		dockerfile.indexOf('COPY --chown=root:root .docker/release/files /'),
	'The application root must be secured after the final root-owned overlay copy.'
);
console.log('Coordinated Jenkins deployment contract checks passed');
