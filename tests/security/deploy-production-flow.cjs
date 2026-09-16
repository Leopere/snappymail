#!/usr/bin/env node
// Copyright © 2026 ColinKnapp.com. All rights reserved.

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const deploy = path.join(root, 'scripts/deploy-production.sh');
const revision = 'b'.repeat(40);
const image = 'ghcr.io/leopere/boompay-snappymail@sha256:' + 'a'.repeat(64);
const imageId = 'sha256:' + 'c'.repeat(64);

function acceptedReceipt(pairOverride = {}) {
	return {
		schema: 'jenkins-boompay-image/v1', application: 'snappymail', revision, image, image_id: imageId,
		result: 'pass', host_activation: {
			schema: 'jenkins-host-appliance-activation/v1', application: 'snappymail', source_revision: revision,
			image, image_config_digest: imageId, provenance: 'jenkins', snappymail_pair: {
				schema: 'jenkins-snappymail-pair/v1', revision, image, image_id: imageId,
				targets: ['mail.boompay.ca', 'mail.nixc.us'],
                boompay_runtime_image_id: 'sha256:' + 'd'.repeat(64),
                nix_runtime_image_id: 'sha256:' + 'e'.repeat(64),
                controller_revisions: { boompay: 'f'.repeat(40), nix: '1'.repeat(40) },
                openpgp_report: { status: 'passed', sha256: '2'.repeat(64) }, ...pairOverride
			}
		}
	};
}

function runMock(pairOverride = {}, options = {}) {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'snappymail-jenkins-flow-'));
	const password = path.join(fixture, 'password');
	fs.writeFileSync(password, 'test-password\n', { mode: 0o600 });
	let triggerCount = 0;
	let crumbSeen = false;
	let buildStatusRequests = 0;
	let queueRequests = 0;
	const server = http.createServer((request, response) => {
		const base = `http://127.0.0.1:${server.address().port}`;
		const pathname = new URL(request.url, base).pathname;
		const parameters = value => [{ parameters: [{ name: 'EXPECTED_REVISION', value }] }];
		const queue = value => {
			queueRequests += 1;
			const item = { task: { url: base + '/job/deploy-snappymail-boompay-ca/' }, actions: parameters(value) };
			if (!options.existingQueue || queueRequests > 1) item.executable = { number: 42, url: base + '/job/deploy-snappymail-boompay-ca/42/' };
			return item;
		};
		if (!/^Basic /.test(request.headers.authorization || '')) {
			return response.writeHead(403).end();
		}
		if (pathname === '/job/deploy-snappymail-boompay-ca/api/json') {
			const state = {};
			if (options.existingQueue) state.queueItem = {
				id: 7, url: options.existingQueueUrl || base + '/queue/item/7/'
			};
			if (options.existingBuildRevision) state.lastBuild = {
				number: 42, building: true, url: base + '/job/deploy-snappymail-boompay-ca/42/', actions: parameters(options.existingBuildRevision)
			};
			return response.end(JSON.stringify(state));
		}
		if (pathname === '/crumbIssuer/api/json') return response.end(JSON.stringify({ crumbRequestField: 'Jenkins-Crumb', crumb: 'crumb-value' }));
		if (pathname === '/job/deploy-snappymail-boompay-ca/buildWithParameters') {
			triggerCount += 1;
			crumbSeen = request.headers['jenkins-crumb'] === 'crumb-value';
			let body = ''; request.on('data', data => { body += data; });
			return request.on('end', () => {
				assert.strictEqual(body, `EXPECTED_REVISION=${revision}`);
				response.writeHead(201, { Location: base + '/queue/item/7/' }).end();
			});
		}
		if (pathname === '/queue/item/7/api/json') return response.end(JSON.stringify(queue(options.existingQueueRevision || revision)));
		if (pathname === '/job/deploy-snappymail-boompay-ca/42/api/json') {
			buildStatusRequests += 1;
			if (options.transientGet && buildStatusRequests === 1) return response.writeHead(503).end();
			if (options.existingBuildRevision && buildStatusRequests === 1) {
				return response.end(JSON.stringify({ number: 42, url: base + '/job/deploy-snappymail-boompay-ca/42/', building: true, actions: parameters(options.existingBuildRevision) }));
			}
			return response.end(JSON.stringify({ number: 42, url: base + '/job/deploy-snappymail-boompay-ca/42/', building: false, result: 'SUCCESS', actions: parameters(options.existingBuildRevision || revision) }));
		}
		if (pathname === '/job/deploy-snappymail-boompay-ca/42/artifact/release/accepted.json') return response.end(JSON.stringify(acceptedReceipt(pairOverride)));
		response.writeHead(404).end();
	});
	return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', () => {
		const child = childProcess.spawn(options.resume ? path.join(root, 'scripts/jenkins-release.py') : deploy,
			options.resume ? [revision, '42'] : [], {
			env: { ...process.env, DEPLOY_IT_COMMIT: revision, DEPLOY_IT_ENVIRONMENT: 'production', SNAPPYMAIL_JENKINS_TESTING: '1', SNAPPYMAIL_JENKINS_TEST_URL: `http://127.0.0.1:${server.address().port}`, SNAPPYMAIL_JENKINS_TEST_PASSWORD_FILE: password, SNAPPYMAIL_JENKINS_TIMEOUT_SECONDS: '5' }
		});
		let stdout = '', stderr = '';
		child.stdout.on('data', data => { stdout += data; });
		child.stderr.on('data', data => { stderr += data; });
		child.once('error', reject);
		child.once('close', status => server.close(() => {
			try { fs.rmSync(fixture, { recursive: true, force: true }); } catch (error) {
				if (error.code !== 'EPERM') throw error;
			}
			resolve({ status, stdout, stderr, triggerCount, crumbSeen, buildStatusRequests });
		}));
	}));
}

(async () => {
	const success = await runMock();
	assert.strictEqual(success.status, 0, success.stderr);
	assert.strictEqual(success.triggerCount, 1, 'one Jenkins build must activate both targets');
	assert(success.crumbSeen, 'the Jenkins trigger must include its CSRF crumb');
	assert.match(success.stdout, /BoomPay and nixc\.us SnappyMail accepted revision=/);
	const queued = await runMock({}, { existingQueue: true });
	assert.strictEqual(queued.status, 0, queued.stderr);
	assert.strictEqual(queued.triggerCount, 0, 'a matching queued release must be monitored without another POST');
	assert.match(queued.stdout, /Attaching to existing SnappyMail Jenkins queue item/);
	const relativeQueue = await runMock({}, { existingQueue: true, existingQueueUrl: 'queue/item/7/' });
	assert.strictEqual(relativeQueue.status, 0, relativeQueue.stderr);
	assert.strictEqual(relativeQueue.triggerCount, 0, 'the known Jenkins relative queue URL must attach without another POST');
	const running = await runMock({}, { existingBuildRevision: revision });
	assert.strictEqual(running.status, 0, running.stderr);
	assert.strictEqual(running.triggerCount, 0, 'a matching running release must be monitored without another POST');
	assert.match(running.stdout, /Attaching to existing SnappyMail Jenkins build #42/);
	const otherRevision = await runMock({}, { existingBuildRevision: 'd'.repeat(40) });
	assert.strictEqual(otherRevision.status, 0, otherRevision.stderr);
	assert.strictEqual(otherRevision.triggerCount, 1, 'a different revision must never be attached');
	const queuedOtherRunningExpected = await runMock({}, {
		existingQueue: true, existingQueueRevision: 'd'.repeat(40), existingBuildRevision: revision
	});
	assert.strictEqual(queuedOtherRunningExpected.status, 0, queuedOtherRunningExpected.stderr);
	assert.strictEqual(queuedOtherRunningExpected.triggerCount, 0,
		'a different queued revision must not hide the requested running build');
	assert.match(queuedOtherRunningExpected.stdout, /Attaching to existing SnappyMail Jenkins build #42/);
	const invalidQueueUrl = await runMock({}, { existingQueue: true, existingQueueUrl: 'queue/item/8/' });
	assert.notStrictEqual(invalidQueueUrl.status, 0, 'an arbitrary relative queue URL must fail closed');
	assert.strictEqual(invalidQueueUrl.triggerCount, 0, 'an invalid queue identity must not post a release');
	const retried = await runMock({}, { transientGet: true });
	assert.strictEqual(retried.status, 0, retried.stderr);
	assert.strictEqual(retried.buildStatusRequests, 2, 'a transient Jenkins GET must retry once');
	const resumed = await runMock({}, { resume: true, transientGet: true });
	assert.strictEqual(resumed.status, 0, resumed.stderr);
	assert.strictEqual(resumed.triggerCount, 0, 'resuming an existing build must not post another release');
	assert.match(resumed.stdout, /Resuming SnappyMail Jenkins build #42 monitoring/);

	const mismatch = await runMock({ revision: 'd'.repeat(40) });
	assert.notStrictEqual(mismatch.status, 0, 'a paired receipt for another revision must fail');
	assert.match(mismatch.stderr, /paired SnappyMail receipt does not bind/);
    for (const invalid of [
        { targets: ['mail.boompay.ca'] },
        { boompay_runtime_image_id: '' },
        { nix_runtime_image_id: '' },
        { openpgp_report: { status: 'failed', sha256: '2'.repeat(64) } }
    ]) {
        const rejected = await runMock(invalid);
        assert.notStrictEqual(rejected.status, 0, 'incomplete paired acceptance must fail');
    }
	console.log('Offline Jenkins paired-release flow checks passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
