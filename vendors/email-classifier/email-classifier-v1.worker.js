// Versioned because production serves classifier assets with immutable caching.
const CATEGORIES = ['calendar', 'contract', 'finance', 'security', 'newsletter', 'notification', 'personal'];
const PROTOTYPES = {
	calendar: [
		'A meeting invitation with a date, time, participants, and RSVP.',
		'An appointment, event, or schedule update.',
		'A request to arrange or reschedule a meeting.'
	],
	contract: [
		'A contract or agreement that needs review or signature.',
		'A legal document, proposal, lease, waiver, or NDA.',
		'A document is ready for electronic signature.'
	],
	finance: [
		'An invoice, receipt, account statement, or payment notice.',
		'A billing, payroll, tax, refund, or remittance message.',
		'A purchase order or financial transaction update.'
	],
	security: [
		'A password reset, verification code, or account security alert.',
		'An unusual sign-in, suspicious activity, or locked account.',
		'A two-factor authentication or identity verification message.'
	],
	newsletter: [
		'A newsletter, weekly digest, marketing offer, or mailing list post.',
		'A promotional announcement sent to many subscribers.',
		'A recurring publication with an unsubscribe option.'
	],
	notification: [
		'An automated system notification, delivery report, or service status update.',
		'A build, server, monitoring, or account activity notification.',
		'An automatic confirmation that does not require a conversation.'
	],
	personal: [
		'A direct personal conversation between two people.',
		'A colleague, customer, friend, or family member sent a personal reply.',
		'A human follow-up to an earlier conversation.',
		'Would you like to catch up over coffee tomorrow?',
		'Thanks for your help; it was great speaking with you.'
	]
};

let extractorPromise;
let prototypePromise;

const dot = (left, right) => {
	let value = 0;
	for (let index = 0; index < left.length; ++index) {
		value += left[index] * right[index];
	}
	return value;
};

const loadExtractor = () => extractorPromise ||= import('./runtime/transformers.min.js').then(module => {
	const base = new URL('./', self.location.href).href;
	module.env.allowRemoteModels = false;
	module.env.allowLocalModels = true;
	module.env.localModelPath = new URL('./models/', base).href;
	module.env.backends.onnx.wasm.wasmPaths = new URL('./runtime/', base).href;
	module.env.backends.onnx.wasm.numThreads = 1;
	module.env.backends.onnx.wasm.proxy = false;
	return module.pipeline('feature-extraction', 'minilm-l3', {
		quantized: true,
		local_files_only: true
	});
});

const getPrototypeVectors = async extractor => prototypePromise ||= (async () => {
	const labels = [], texts = [];
	CATEGORIES.forEach(category => PROTOTYPES[category].forEach(text => {
		labels.push(category);
		texts.push(text);
	}));
	const vectors = (await extractor(texts, { pooling: 'mean', normalize: true })).tolist();
	return labels.map((category, index) => ({ category, vector: vectors[index] }));
})();

const classifyBatch = async items => {
	const extractor = await loadExtractor(), prototypes = await getPrototypeVectors(extractor);
	const texts = items.map(item => String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 4096));
	const vectors = (await extractor(texts, { pooling: 'mean', normalize: true })).tolist();
	return items.map((item, index) => {
		const scores = Object.fromEntries(CATEGORIES.map(category => [category, -1]));
		prototypes.forEach(prototype => {
			scores[prototype.category] = Math.max(scores[prototype.category], dot(vectors[index], prototype.vector));
		});
		if (CATEGORIES.includes(item.hintCategory) && Number(item.hintConfidence) >= .85) {
			scores[item.hintCategory] += .035;
		}
		const ranked = CATEGORIES.map(category => ({ category, score: scores[category] }))
			.sort((left, right) => right.score - left.score),
			top = ranked[0], margin = top.score - ranked[1].score;
		if (.34 > top.score || .018 > margin) {
			return { id: item.id, category: 'other', confidence: 0, source: 'minilm' };
		}
		return {
			id: item.id,
			category: top.category,
			confidence: Math.min(.94, Math.max(.56, .58 + (top.score - .34) * .75 + margin * 1.5)),
			source: 'minilm'
		};
	});
};

self.addEventListener('message', event => {
	if ('classify' !== event.data?.type || !Array.isArray(event.data.items)) {
		return;
	}
	const items = event.data.items.slice(0, 64).filter(item => item && null != item.id);
	classifyBatch(items).then(results => self.postMessage({ type: 'results', results })).catch(() => {
		self.postMessage({ type: 'error', message: 'Local classifier unavailable' });
	});
});
