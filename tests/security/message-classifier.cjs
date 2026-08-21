#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..'),
	read = file => fs.readFileSync(path.join(root, file), 'utf8'),
	rulesSource = read('dev/Classifier/Rules.js'),
	moduleSource = rulesSource
		.replace(/export const\b/g, 'const')
		.replace(/export function\b/g, 'function')
		+ '\nmodule.exports = { CLASSIFIER_CATEGORIES, CLASSIFIER_CATEGORY_OPTIONS, classifyMessageMetadata };',
	context = {
		module: { exports: {} },
		fetch: () => { throw new Error('Classifier attempted a network request'); },
		XMLHttpRequest: function () { throw new Error('Classifier attempted a network request'); },
		localStorage: new Proxy({}, { get: () => { throw new Error('Classifier attempted storage access'); } }),
		sessionStorage: new Proxy({}, { get: () => { throw new Error('Classifier attempted storage access'); } })
	};

vm.runInNewContext(moduleSource, context, { filename: 'Classifier/Rules.js' });

const {
	CLASSIFIER_CATEGORIES,
	CLASSIFIER_CATEGORY_OPTIONS,
	classifyMessageMetadata
} = context.module.exports,
	classify = input => JSON.parse(JSON.stringify(classifyMessageMetadata(input))),
	attachment = (fileName, mimeType = 'application/pdf') => ({ fileName, mimeType }),
	expectClassification = (input, category, actionRequired = false) => {
		const actual = classify(input);
		assert.equal(actual.category, category);
		assert.equal(actual.actionRequired, actionRequired);
		assert.equal(actual.source, 'rules');
		return actual;
	};

const categoriesSource = read('dev/Classifier/Categories.js'),
	categoriesModuleSource = categoriesSource
		.replace("import { CLASSIFIER_CATEGORY_OPTIONS } from 'Classifier/Rules';",
			`const CLASSIFIER_CATEGORY_OPTIONS = ${JSON.stringify(CLASSIFIER_CATEGORY_OPTIONS)};`)
		.replace(/export const\b/g, 'const')
		.replace(/export function\b/g, 'function')
		+ '\nmodule.exports = { AUTOMATIC_CATEGORY_FLAG, CATEGORY_FLAG_PREFIX, SMART_CATEGORY_OPTIONS, '
			+ 'SMART_CATEGORY_VALUES, categoryKeyword, parseCategoryFolderRoutes, serializeCategoryFolderRoutes };',
	categoriesContext = { module: { exports: {} } };

vm.runInNewContext(categoriesModuleSource, categoriesContext, { filename: 'Classifier/Categories.js' });

const {
	AUTOMATIC_CATEGORY_FLAG,
	SMART_CATEGORY_OPTIONS,
	SMART_CATEGORY_VALUES,
	categoryKeyword,
	parseCategoryFolderRoutes,
	serializeCategoryFolderRoutes
} = categoriesContext.module.exports;

assert.equal(AUTOMATIC_CATEGORY_FLAG, '$smcat-auto');
assert.deepEqual(Array.from(SMART_CATEGORY_VALUES),
	['calendar', 'contract', 'finance', 'security', 'newsletter', 'notification']);
assert.deepEqual(Array.from(SMART_CATEGORY_OPTIONS, option => option.value), Array.from(SMART_CATEGORY_VALUES));
assert.equal(categoryKeyword('finance'), '$smcat-finance');
assert.deepEqual(JSON.parse(JSON.stringify(parseCategoryFolderRoutes(JSON.stringify({
	finance: 'Categories/Finance',
	personal: 'Categories/Personal',
	security: 'Bad\nFolder'
})))), { finance: 'Categories/Finance' }, 'only safe routable categories may be persisted');
assert.equal(serializeCategoryFolderRoutes('{broken'), '{}', 'invalid routing settings must fail closed');

assert.deepEqual(
	Array.from(CLASSIFIER_CATEGORIES),
	['calendar', 'contract', 'finance', 'security', 'newsletter', 'notification', 'personal', 'other'],
	'categories must remain a closed finite enum'
);
assert.deepEqual(
	Array.from(CLASSIFIER_CATEGORY_OPTIONS, option => option.value),
	Array.from(CLASSIFIER_CATEGORIES),
	'every category must have exactly one UI option'
);
assert.equal(
	CLASSIFIER_CATEGORY_OPTIONS.find(option => 'security' === option.value)?.label,
	'Account alerts',
	'sender-controlled alert wording must not be presented as a security assurance'
);

let actual = expectClassification({
	contentType: 'multipart/report; report-type=delivery-status',
	attachments: [attachment('status.txt', 'message/delivery-status')]
}, 'notification');
assert.equal(actual.confidence, 1, 'standards-based reports must be structurally decisive');
assert.deepEqual(actual.reasonCodes, ['mime.report']);

actual = expectClassification({
	subject: 'Project sync',
	attachments: [attachment('project.ics', 'text/calendar')]
}, 'calendar');
assert.equal(actual.actionRequired, false, 'a calendar object is not necessarily an invitation');

actual = expectClassification({
	subject: 'Invitation: Project sync — RSVP requested',
	attachments: [attachment('project.ics', 'text/calendar')]
}, 'calendar', true);
assert(actual.reasonCodes.includes('action.calendar'));

expectClassification({ subject: 'Review the calendar migration plan' }, 'other');

actual = expectClassification({
	subject: 'Document available',
	preview: 'Please continue at https://sign.boompay.ca/s/123456789ABCDE today.'
}, 'contract', true);
assert.equal(actual.confidence, 0.99);
assert(!JSON.stringify(actual).includes('123456789ABCDE'), 'private signing tokens must not enter classifier output');

expectClassification({
	subject: 'Please review and sign the service agreement',
	attachments: [attachment('service-agreement.pdf')]
}, 'contract', true);
expectClassification({ subject: 'Our agreement about lunch' }, 'other');

expectClassification({
	subject: 'Your July document',
	attachments: [attachment('invoice-2026-07.pdf')]
}, 'finance');
expectClassification({
	subject: 'Invoice overdue — payment declined',
	attachments: [attachment('invoice.pdf')]
}, 'finance', true);
expectClassification({ subject: 'Payment received and confirmed' }, 'finance');

expectClassification({ subject: 'Security alert: new sign-in' }, 'security');
expectClassification({ subject: 'Unusual login detected — please review' }, 'security', true);

actual = expectClassification({
	subject: 'Weekly engineering digest',
	headers: { 'List-Id': '<engineering.example>', Precedence: 'list' }
}, 'newsletter');
assert.equal(actual.confidence, 0.96);

expectClassification({
	subject: 'Invoice available',
	headers: { 'LIST-UNSUBSCRIBE': '<mailto:unsubscribe@example.test>' },
	attachments: [attachment('invoice.pdf')]
}, 'finance');

expectClassification({
	subject: 'Nightly backup status',
	headers: [{ name: 'Auto-Submitted', value: 'auto-generated' }]
}, 'notification');
expectClassification({
	subject: 'Action required: review the backup report',
	headers: { Precedence: 'bulk' }
}, 'notification', true);

expectClassification({
	subject: 'A note for you',
	senderEmail: 'noreply@example.test'
}, 'other');
expectClassification({
	subject: 'Re: Dinner tomorrow',
	headers: { 'In-Reply-To': '<prior@example.test>' }
}, 'other');

assert.doesNotThrow(() => classifyMessageMetadata(null));
assert.doesNotThrow(() => classifyMessageMetadata({
	subject: { toString: () => { throw new Error('must not coerce arbitrary input'); } },
	headers: 7,
	attachments: [null, 3, {}]
}));

const privateText = 'private-needle-' + 'x'.repeat(10000),
	bounded = expectClassification({
		subject: privateText,
		preview: privateText,
		attachments: Array.from({ length: 100 }, (_, index) => attachment(`${privateText}-${index}.txt`, 'text/plain'))
	}, 'other');
assert(!JSON.stringify(bounded).includes('private-needle'), 'classifier output must never echo input text');
assert.match(rulesSource, /const TEXT_BUDGET = 2048/,
	'classifier input must have a small explicit total text budget');

const metadata = {
	subject: 'Security alert: new sign-in',
	preview: 'Known preview',
	attachments: []
};
assert.deepEqual(
	classify({ ...metadata, plain: 'invoice overdue', html: '<b>please sign</b>', body: 'secret' }),
	classify({ ...metadata, plain: 'different', html: '<i>different</i>', body: 'different' }),
	'body and decrypted content must not affect metadata classification'
);
assert.doesNotMatch(rulesSource, /\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage|Remote)\b/,
	'rule classification must not use network, remote actions, or browser storage');

const headerEnum = read('snappymail/v/0.0.0/app/libraries/MailSo/Mime/Enumerations/Header.php'),
	mailClient = read('snappymail/v/0.0.0/app/libraries/MailSo/Mail/MailClient.php'),
	listMethod = mailClient.match(/protected function MessageListByRequestIndexOrUids[\s\S]*?\n\t}\n\n\t\/\*\*/)?.[0] || '';

for (const [constant, value] of [
	['AUTO_SUBMITTED', 'Auto-Submitted'],
	['LIST_ID', 'List-Id'],
	['PRECEDENCE', 'Precedence']
]) {
	assert(headerEnum.includes(`${constant} = '${value}'`), `${value} needs a canonical MIME header constant`);
	assert(mailClient.includes(`MimeHeader::${constant}`), `${value} must be included in list header fetches`);
}
assert(listMethod.includes('FetchType::BODYSTRUCTURE'), 'message-list classification may use existing BODYSTRUCTURE metadata');
assert(listMethod.includes('FetchType::PREVIEW'), 'message-list classification may use PREVIEW when the server offers it');
assert.doesNotMatch(listMethod, /FetchType::BODY_PEEK\s*\./,
	'message-list classification must not add a message-body fetch');

console.log('Deterministic message classifier checks passed');
