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
	'./scripts/set-snappymail-release.py',
	'./scripts/verify.sh',
	'BOOMPAY_APPLICATION_RELEASE=snappymail',
	'"$ship_it_bin"',
	'https://mail.boompay.ca/'
]) {
	assert(deploy.includes(required), `Missing direct production contract: ${required}`);
}
assert(!deploy.includes('${HOME'), 'The deploy-it snapshot clears HOME; deployment must resolve the OS account home directory.');
assert(deploy.includes('pwd.getpwuid(os.getuid()).pw_dir'));
assert(deploy.includes('docker_config/cli-plugins/docker-buildx'));
assert(deploy.includes('DOCKER_CONFIG="$docker_config" docker buildx version'));
assert(deploy.indexOf('docker buildx imagetools inspect') < deploy.indexOf('./scripts/set-snappymail-release.py'));
assert(deploy.indexOf('./scripts/set-snappymail-release.py') < deploy.indexOf('./scripts/verify.sh'));
assert(deploy.indexOf('./scripts/verify.sh') < deploy.lastIndexOf('"$ship_it_bin"'));
assert(dockerfile.includes('ARG SOURCE_REVISION'));
assert(dockerfile.includes('LABEL org.opencontainers.image.revision="$SOURCE_REVISION"'));
console.log('Direct production deployment contract checks passed');
