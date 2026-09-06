const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const compose = fs.readFileSync(path.join(root, 'dev/View/Popup/Compose.js'), 'utf8');
const methodStart = compose.indexOf('\tasync getMessageRequestParams(sSaveFolder, draft)');
const methodEnd = compose.indexOf('\n\t}\n}\n\n/**', methodStart);
assert(methodStart >= 0 && methodEnd > methodStart, 'Locate the production compose request builder.');

const methodSource = compose.slice(methodStart, methodEnd + 3);
assert(compose.includes("usePlaintextFallback(i18n('COMPOSE/OPENPGP_PLAINTEXT_ATTACHMENT_NOTICE'))"),
	'An automatic OpenPGP attachment limitation must enter the same plaintext confirmation path.');
assert(compose.includes("usePlaintextFallback(i18n('COMPOSE/OPENPGP_PLAINTEXT_ENCRYPTION_NOTICE'))"),
	'An automatic OpenPGP encryption failure must enter the same plaintext confirmation path.');
const observable = initial => {
	let value = initial;
	return (...args) => args.length ? (value = args[0]) : value;
};
const identity = { id: () => 'identity-id', email: 'sender@nixc.us' };
const recipientFields = { to: 'recipient@nixc.us', cc: 'copy@nixc.us', bcc: 'blind@nixc.us' };

const makeView = () => ({
	oEditor: { getData: () => 'Plain same-domain message', isHtml: () => false },
	attachments: [{
		complete: () => true, tempName: () => 'upload-token', enabled: () => true,
		fileName: () => 'contract.pdf', isInline: false, cId: '', contentLocation: '',
		mimeType: () => 'application/pdf'
	}],
	currentIdentity: () => identity,
	draftsFolder: () => 'Drafts', draftUid: () => 0, from: () => 'sender@nixc.us',
	to: () => recipientFields.to, cc: () => recipientFields.cc, bcc: () => recipientFields.bcc,
	replyTo: () => '', subject: () => 'Plaintext fallback contract', aDraftInfo: [],
	sInReplyTo: '', sReferences: '', markAsImportant: () => false, requestDsn: () => false,
	requireTLS: () => false, requestReadReceipt: () => false,
	messageRecipients: () => Object.values(recipientFields),
	encryptionRecipients: () => ['sender@nixc.us', ...Object.values(recipientFields)],
	signOptions: observable([['OpenPGP', { key: 'private-key' }]]), encryptOptions: observable(['OpenPGP']),
	doSign: observable(true), doEncrypt: observable(true), plaintextNotice: observable(''),
	plaintextFallbackPending: false, automaticOpenPgpPolicy: true, bodyArea() {},
	initEncrypt: async () => { throw Error('initEncrypt must not run without a usable automatic OpenPGP state'); }
});

const instantiateRequestBuilder = ({ vaultReady, missingKeys }) => vm.runInNewContext(`({ ${methodSource} })`, {
	PgpUserStore: { ready: async () => vaultReady },
	OpenPGPUserStore: {
		isSupported: () => true,
		missingPublishedPublicKeysForEmails: async () => missingKeys,
		vaultError: () => 'unavailable vault'
	},
	i18n: (key, values) => `${key}:${values ? JSON.stringify(values) : ''}`,
	htmlToPlain: text => text,
	base64_encode: text => text,
	MimePart: class {}
}).getMessageRequestParams;

(async () => {

for (const scenario of [
	{ name: 'unavailable browser vault', vaultReady: false, missingKeys: [] },
	{ name: 'missing same-domain WKD keys', vaultReady: true, missingKeys: ['recipient@nixc.us'] }
]) {
	const view = makeView();
	const getMessageRequestParams = instantiateRequestBuilder(scenario);
	const params = await getMessageRequestParams.call(view, 'Sent', false);
	assert.equal(params.to, recipientFields.to, `${scenario.name}: retain To.`);
	assert.equal(params.cc, recipientFields.cc, `${scenario.name}: retain Cc.`);
	assert.equal(params.bcc, recipientFields.bcc, `${scenario.name}: retain Bcc.`);
	assert.equal(params.plain, 'Plain same-domain message', `${scenario.name}: retain original plaintext body.`);
	assert.deepEqual(JSON.parse(JSON.stringify(params.attachments)), {
		'upload-token': { name: 'contract.pdf', inline: false, cId: '', location: '', type: 'application/pdf' }
	}, `${scenario.name}: retain completed attachments.`);
	assert.equal(params.encrypted, undefined, `${scenario.name}: do not send partial ciphertext.`);
	assert.equal(params.signed, undefined, `${scenario.name}: do not send a detached partial signature.`);
	assert.equal(view.plaintextFallbackPending, true, `${scenario.name}: require explicit plaintext confirmation.`);
	assert.match(view.plaintextNotice(), /OPENPGP_PLAINTEXT_(VAULT|RECIPIENTS)_NOTICE/,
		`${scenario.name}: explain why plaintext confirmation is required.`);
	assert.equal(view.doEncrypt(), false, `${scenario.name}: disable automatic encryption before confirmation.`);
	assert.equal(view.doSign(), false, `${scenario.name}: disable automatic signing before confirmation.`);
}

const confirmStart = compose.indexOf('\t\t\t\t\tconst confirmPlaintextSend = params => {');
const confirmEnd = compose.indexOf('\n\n\t\t\t\t\tthis.getMessageRequestParams', confirmStart);
assert(confirmStart >= 0 && confirmEnd > confirmStart, 'Locate the production plaintext confirmation callback.');
const confirmSource = compose.slice(confirmStart, confirmEnd);
const popupCalls = [];
const confirmFactory = vm.runInNewContext(`
	(function (sendMessage) {
		${confirmSource}
		return confirmPlaintextSend;
	})
`, {
	i18n: key => key,
	AskPopupView: {},
	showScreenPopup: (view, params) => popupCalls.push({ view, params })
});

{
	const sent = [];
	const view = { plaintextFallbackPending: true, sending: observable(true) };
	const params = { to: recipientFields.to, cc: recipientFields.cc, bcc: recipientFields.bcc, plain: 'confirm me' };
	confirmFactory.call(view, value => sent.push(value))(params);
	assert.equal(sent.length, 0, 'Opening confirmation must not send mail.');
	assert.equal(popupCalls.length, 1, 'Plaintext fallback must show one confirmation dialog.');
	popupCalls[0].params[2]();
	assert.equal(sent.length, 0, 'Cancel must not send mail.');
	assert.equal(view.sending(), false, 'Cancel must unlock compose.');
	popupCalls[0].params[1]();
	assert.deepEqual(sent, [params], 'Explicit approval must send the exact whole plaintext request.');
}

console.log('Same-domain automatic OpenPGP plaintext fallback checks passed');
})().catch(error => {
	console.error(error.stack || error.message || error);
	process.exitCode = 1;
});
