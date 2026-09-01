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

assert.deepStrictEqual(manifest, {
	version: 1,
	after_ship: true,
	environment: 'production',
	timeout_seconds: 3600,
	command: ['./scripts/deploy-production.sh'],
	env: []
});
for (const required of [
	'docker buildx build',
	'docker buildx version',
	'--platform linux/amd64',
	'--metadata-file "$metadata"',
	'containerimage.digest',
	'docker buildx imagetools inspect',
	'docker run --rm --platform linux/amd64',
	'www-data:www-data:550',
	'test -r /snappymail/index.php',
	'su www-data -s /bin/sh -c "php -r',
	'./scripts/set-snappymail-release.py',
	'./scripts/verify.sh',
	'BOOMPAY_PLATFORM_ROOT=none',
	'BOOMPAY_GARAGE_ROOT=none',
	'BOOMPAY_CAPITAL_ROOT=none',
	'BOOMPAY_PARTNERS_ROOT=none',
	'BOOMPAY_APPLICATION_RELEASE=snappymail',
	'BOOMPAY_OPERATOR_WORKSPACE_LIFECYCLE=none',
	'BOOMPAY_TRUST_PINNED_HOST_IP=1',
	'"$ship_it_bin"',
	'https://mail.boompay.ca/'
]) {
	assert(deploy.includes(required), `Missing direct production contract: ${required}`);
}
assert(!deploy.includes('${HOME'), 'The deploy-it snapshot clears HOME; deployment must resolve the OS account home directory.');
assert(deploy.includes('pwd.getpwuid(os.getuid()).pw_dir'));
assert(deploy.includes('docker_config/cli-plugins/docker-buildx'));
assert(deploy.includes('DOCKER_CONFIG="$docker_config" docker buildx version'));
assert(deploy.includes('["gh", "auth", "token", "--hostname", "github.com"]'));
assert(deploy.includes('os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600'));
assert(deploy.includes('{"auths": {"ghcr.io": {"auth": credential}}}'));
assert(!deploy.includes('docker login'),
	'The non-interactive deploy must not invoke a macOS credential helper.');
assert(deploy.indexOf('docker buildx imagetools inspect') < deploy.indexOf('./scripts/set-snappymail-release.py'));
assert(deploy.indexOf('docker run --rm --platform linux/amd64') < deploy.indexOf('./scripts/set-snappymail-release.py'));
assert(deploy.indexOf('./scripts/set-snappymail-release.py') < deploy.indexOf('./scripts/verify.sh'));
assert(deploy.indexOf('./scripts/verify.sh') < deploy.lastIndexOf('"$ship_it_bin"'));
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
console.log('Direct production deployment contract checks passed');
