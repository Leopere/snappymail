const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const assert = (condition, message) => {
	if (!condition) throw Error(message);
};
const observable = initial => {
	let value = initial;
	const subscribers = [];
	function result(next) {
		if (arguments.length) {
			value = next;
			subscribers.slice().forEach(callback => callback(value));
			return result;
		}
		return value;
	}
	result.subscribe = callback => subscribers.push(callback);
	return result;
};
const observableArray = initial => observable(initial || []);
const pending = new Map();
const listeners = new Map();
const settings = { enabled: true, mailbox: 'integration@example.test' };

class PopupView {
	constructor(name) {
		this.name = name;
		this.closed = false;
		this.tryToClose = () => {
			if (false !== this.onClose?.()) {
				this.close();
			}
		};
	}

	addObservables(values) {
		Object.entries(values).forEach(([name, value]) => this[name] = observable(value));
	}

	close() {
		this.closed = true;
		this.onHide?.();
	}

	static showModal(parameters) {
		this.__vm ||= new this();
		this.__vm.closed = false;
		this.__vm.beforeShow(...parameters);
		PopupView.last = this.__vm;
	}
}

const rl = {
	pluginPopupView: PopupView,
	pluginSettingsGet: (section, name) => 'rocksign' === section ? settings[name] : undefined,
	pluginRemoteRequest: (callback, action, parameters) => {
		const requests = pending.get(action) || [];
		requests.push({ callback, parameters });
		pending.set(action, requests);
	}
};
const context = vm.createContext({
	window: { rl },
	rl,
	ko: { observable, observableArray },
	Promise,
	setTimeout,
	clearTimeout,
	console,
	Element: { fromHTML: value => value },
	document: { getElementById: () => null },
	addEventListener: (name, callback) => {
		const callbacks = listeners.get(name) || [];
		callbacks.push(callback);
		listeners.set(name, callbacks);
	}
});

const dispatch = detail => (listeners.get('rl-view-model.create') || [])
	.forEach(callback => callback({ detail }));
const respond = (action, result, error = 0) => {
	const request = (pending.get(action) || []).shift();
	assert(request, `No pending ${action} request exists.`);
	request.callback(error, { Result: result });
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const makeCompose = label => {
	const editor = {
		data: `${label} body`,
		isPlain: () => true,
		getData() { return this.data; },
		setPlain(value) { this.data = value; },
		setHtml(value) { this.data = value; }
	};
	return {
		viewModelTemplateID: 'PopupsCompose',
		from: observable('<integration@example.test>'),
		to: observable(`${label}@recipient.test`),
		cc: observable(`${label}-cc@recipient.test`),
		bcc: observable(''),
		showCc: observable(true),
		showBcc: observable(false),
		subject: observable(`${label} subject`),
		attachments: observableArray([]),
		messageRecipients: () => [],
		attachmentsArea: () => {},
		bodyArea: () => {},
		addAttachmentHelper: () => ({
			tempName: observable(''), fileName: observable(''), size: observable(0), type: observable(''),
			error: observable(''), uploading: observable(false), complete: observable(false)
		}),
		oEditor: editor
	};
};

(async () => {
	for (const file of ['plugins/rocksign/js/rocksign.js', 'plugins/rocksign/js/admin.js']) {
		vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
	}

	const composeA = makeCompose('first');
	const composeB = makeCompose('second');
	dispatch(composeA);
	assert(composeA.rockSignEnabled, 'The lowercase AppData setting must enable the Compose Contracts menu.');

	composeA.rockSignOpen('request');
	const popup = PopupView.last;
	await flush();
	respond('RockSignTemplates', {
		success: true,
		templates: [{ id: 42, name: 'Acquisition', roles: [{ name: 'Buyer' }] }]
	});
	await flush();
	popup.roles()[0].email('signer@example.test');
	popup.delivery('snappymail');
	popup.confirmLocalDelivery(true);
	popup.execute();
	assert(popup.mutationBusy(), 'Submission creation must synchronously lock popup closing.');
	popup.tryToClose();
	assert(!popup.closed, 'A signing-request mutation must not be closable while its response is pending.');
	popup.beforeShow('certify', composeB);
	assert(popup.compose === composeA && 'request' === popup.mode(),
		'A programmatic reopen must not retarget an in-flight mutation to another Compose draft.');
	await flush();
	respond('RockSignCreateSubmission', {
		success: true,
		created: true,
		status_unknown: false,
		submission_id: 77,
		delivery: 'snappymail',
		links: [{ role: 'Buyer', email: 'signer@example.test', embed_src: 'https://sign.boompay.ca/s/123456789ABCDE' }]
	});
	await flush();
	await flush();
	assert('signer@example.test' === composeA.to(), 'The confirmed private link must update the originating draft.');
	assert(composeA.oEditor.data.includes('/s/123456789ABCDE'), 'The originating draft must receive the signing link.');
	assert('second@recipient.test' === composeB.to() && !composeB.oEditor.data.includes('sign.boompay.ca'),
		'A delayed mutation must never alter a different Compose draft.');
	assert(!popup.mutationBusy(), 'The popup mutation lock must clear after response handling.');

	popup.tryToClose();
	assert(popup.closed, 'The popup must close normally after its mutation finishes.');
	popup.beforeShow('completed', composeA);
	await flush();
	assert((pending.get('RockSignCompletedSubmissions') || []).length, 'Completed mode must request owned submissions.');
	popup.tryToClose();
	popup.beforeShow('certify', composeB);
	respond('RockSignCompletedSubmissions', {
		success: true,
		submissions: [{ id: 88, template_name: 'Stale', completed_at: 'yesterday' }]
	});
	await flush();
	await flush();
	assert('certify' === popup.mode() && '' === popup.selectedSubmissionId() && !popup.loadingFiles(),
		'A stale completed-list response must not pollute another workflow or start a file request.');
	assert(!(pending.get('RockSignSubmissionFiles') || []).length,
		'A stale completed-list response must not request files after the popup changes mode.');
	popup.beforeShow('verify', composeB);
	assert('verify' === popup.mode(), 'The singleton popup must safely open the Verify workflow after invalidation.');

	const admin = { viewModelTemplateID: 'PopupsPlugin', id: observable('rocksign') };
	dispatch(admin);
	assert(admin.rockSignTestVisible(), 'The admin connection control must appear only for the RockSign plugin ID.');
	admin.rockSignTestConnection();
	respond('RockSignTestConnection', { success: true, user: { email: 'integration@example.test' } });
	assert(admin.rockSignTestResult().includes('integration@example.test'),
		'The admin connection smoke must display the authenticated RockSign user.');

	console.log('RockSign browser workflow tests passed');
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
