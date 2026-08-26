import { htmlToPlain } from 'Common/Html';
import { staticLink } from 'Common/Links';
import { getFolderFromCacheList, getFolderInboxName } from 'Common/Cache';
import { fireEvent, SettingsGet } from 'Common/Globals';

import Remote from 'Remote/User/Fetch';
import { SettingsUserStore } from 'Stores/User/Settings';

import {
	CLASSIFIER_CATEGORIES,
	CLASSIFIER_CATEGORY_OPTIONS,
	classifyMessageMetadata
} from 'Classifier/Rules';
import {
	AUTOMATIC_CATEGORY_FLAG,
	CATEGORY_FLAG_PREFIX,
	RETENTION_FLAGS,
	SMART_CATEGORY_VALUES,
	categoryKeyword,
	parseCategoryFolderRoutes,
	retentionKeyword
} from 'Classifier/Categories';

const
	CACHE_KEY = 'snappymail-email-classifier-v3',
	LEGACY_CACHE_KEYS = ['snappymail-email-classifier-v1', 'snappymail-email-classifier-v2'],
	CLASSIFIER_MODEL_VERSION = 'minilm-l3-v1',
	CACHE_LIMIT = 750,
	RULE_CONFIDENCE_THRESHOLD = 0.95,
	DISPLAY_CONFIDENCE_THRESHOLD = 0.68,
	MODEL_PERSIST_CONFIDENCE_THRESHOLD = 0.82,
	MAX_CLASSIFIER_TEXT_LENGTH = 12000,
	MAX_PENDING_ITEMS = 256,
	WORKER_TIMEOUT = 45000,
	categorySet = new Set(CLASSIFIER_CATEGORIES),
	lastIdentity = new WeakMap,
	latestSequence = new WeakMap,
	classificationDepth = new WeakMap,
	categoryWrites = new WeakMap,
	categoryRoutes = new WeakMap,
	pending = new Map,
	workerQueue = [];

let classifierWorker = null,
	classifierWorkerUnavailable = false,
	workerBusy = false,
	workerTimer = 0,
	requestId = 0,
	sequence = 0;

const
	readCache = () => {
		try {
			LEGACY_CACHE_KEYS.forEach(key => localStorage.removeItem(key));
			const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
			return parsed && 'object' === typeof parsed && !Array.isArray(parsed) ? parsed : {};
		} catch (e) {
			return {};
		}
	},

	resultCache = readCache(),

	writeCache = () => {
		try {
			const entries = Object.entries(resultCache).sort((left, right) => right[1][2] - left[1][2]);
			entries.slice(CACHE_LIMIT).forEach(([key]) => delete resultCache[key]);
			localStorage.setItem(CACHE_KEY, JSON.stringify(resultCache));
		} catch (e) {
			// Classification remains available when private browsing disables storage.
		}
	},

	cachedResult = key => {
		const value = resultCache[key],
			confidence = Number(value?.[1]);
		return Array.isArray(value)
			&& categorySet.has(value[0])
			&& Number.isFinite(confidence)
			&& confidence >= 0
			&& confidence <= 1
			? { category: value[0], confidence, source: 'model' }
			: null;
	},

	plainValue = value => (null == value ? '' : '' + value).replace(/\s+/g, ' ').trim(),

	clampConfidence = value => Math.max(0, Math.min(1, Number(value) || 0)),

	messageHeaders = message => (message.headers?.() || []).map(header => ({
		name: header.name || '',
		value: header.value || ''
	})),

	messageAttachments = message => (message.attachments?.() || []).map(attachment => ({
		mimeType: attachment.mimeType || '',
		fileName: attachment.fileName || ''
	})),

	messageMetadata = message => {
		const headers = messageHeaders(message);
		return {
			subject: message.subject?.() || '',
			preview: message.preview || '',
			senderEmail: message.from?.[0]?.email || '',
			contentType: headers.find(header => 'content-type' === header.name.toLowerCase())?.value || '',
			headers,
			attachments: messageAttachments(message)
		};
	},

	safeMessageBody = message => {
		if ((message.pgpEncrypted?.() && !message.pgpDecrypted?.())
		 || (message.smimeEncrypted?.() && !message.smimeDecrypted?.())) {
			return '';
		}
		const plain = message.plain?.() || '',
			html = message.html?.() || '';
		if (plain.includes('-----BEGIN PGP MESSAGE-----')
		 || html.includes('-----BEGIN PGP MESSAGE-----')) {
			return '';
		}
		return plain || (html ? htmlToPlain(html) : '');
	},

	classifierText = (message, includeBody) => {
		const metadata = messageMetadata(message),
			from = message.from?.[0],
			text = [
				metadata.subject,
				[from?.name, metadata.senderEmail].filter(Boolean).join(' '),
				metadata.preview,
				includeBody ? safeMessageBody(message) : ''
			]
				.map(plainValue)
				.filter(Boolean)
				.join('\n');
		return text.slice(0, MAX_CLASSIFIER_TEXT_LENGTH);
	},

	classifierIdentity = (message, hint, depth) => {
		const account = plainValue(SettingsGet('accountHash')),
			folder = plainValue(message.folder),
			uid = plainValue(message.uid);
		return account && folder && uid ? JSON.stringify([
			CLASSIFIER_MODEL_VERSION,
			account,
			folder,
			uid,
			depth,
			categorySet.has(hint.category) ? hint.category : 'other',
			Math.round(clampConfidence(hint.confidence) * 1000),
			(hint.reasonCodes || []).slice().sort()
		]) : '';
	},

	applyClassification = (message, result, depth, itemSequence) => {
		if (!message
		 || itemSequence !== latestSequence.get(message)
		 || depth < (classificationDepth.get(message) || 0)
		 || !categorySet.has(result?.category)) {
			return false;
		}
		const confidence = clampConfidence(result.confidence),
			currentCategory = message.classifiedCategory(),
			currentConfidence = clampConfidence(message.classifiedCategoryConfidence());
		classificationDepth.set(message, depth);
		if (currentCategory && (confidence < DISPLAY_CONFIDENCE_THRESHOLD || confidence < currentConfidence)) {
			return false;
		}
		message.classifiedCategory(confidence >= DISPLAY_CONFIDENCE_THRESHOLD ? result.category : '');
		message.classifiedCategoryConfidence(confidence);
		message.classifiedCategorySource(
			'rules' === result.source || 'model' === result.source ? result.source : 'model'
		);
		return true;
	},

	automaticPersistenceAllowed = result => categorySet.has(result?.category)
		&& ('rules' === result.source
			? clampConfidence(result.confidence) >= RULE_CONFIDENCE_THRESHOLD
			: clampConfidence(result.confidence) >= MODEL_PERSIST_CONFIDENCE_THRESHOLD),

	disableWorker = () => {
		clearTimeout(workerTimer);
		workerTimer = 0;
		classifierWorkerUnavailable = true;
		classifierWorker?.terminate();
		classifierWorker = null;
		workerBusy = false;
		workerQueue.length = 0;
		pending.clear();
	},

	handleWorkerMessage = event => {
		const data = event.data;
		if ('error' === data?.type) {
			disableWorker();
			return;
		}
		if ('results' !== data?.type || !Array.isArray(data.results)) {
			return;
		}
		data.results.forEach(result => {
			const item = pending.get(result.id);
			if (item) {
				pending.delete(result.id);
				applyClassification(item.message, result, item.depth, item.sequence)
					&& persistAutomaticCategory(item.message, result);
				if (item.cacheKey && categorySet.has(result.category)) {
					resultCache[item.cacheKey] = [
						result.category,
						Math.round(clampConfidence(result.confidence) * 1000) / 1000,
						Date.now()
					];
				}
			}
		});
		clearTimeout(workerTimer);
		workerTimer = 0;
		writeCache();
		workerBusy = false;
		sendWorkerItems();
	},

	worker = () => {
		if (!classifierWorker && !classifierWorkerUnavailable && window.Worker) try {
			classifierWorker = new Worker(staticLink('classifier-v1/email-classifier-v1.worker.js'), { type: 'module' });
			classifierWorker.addEventListener('message', handleWorkerMessage);
			classifierWorker.addEventListener('error', disableWorker);
			classifierWorker.addEventListener('messageerror', disableWorker);
		} catch (e) {
			disableWorker();
		}
		return classifierWorker;
	},

	sendWorkerItems = () => {
		if (workerBusy || !workerQueue.length) {
			return;
		}
		const instance = worker();
		if (!instance) {
			workerQueue.splice(0).forEach(item => pending.delete(item.id));
			return;
		}
		const items = workerQueue.splice(0, 64);
		workerBusy = true;
		try {
			instance.postMessage({ type: 'classify', items });
			workerTimer = setTimeout(disableWorker, WORKER_TIMEOUT);
		} catch (e) {
			items.forEach(item => pending.delete(item.id));
			disableWorker();
		}
	},

	classify = (messages, includeBody) => {
		if (!SettingsUserStore.smartArchiveEnabled()) {
			return;
		}
		const items = [];
		(messages || []).forEach(message => {
			if (!message?.classifiedCategory) {
				return;
			}

			const body = includeBody ? safeMessageBody(message) : '',
				depth = body ? 1 : 0,
				text = classifierText(message, !!body),
				metadata = messageMetadata(message),
				hint = classifyMessageMetadata(metadata),
				identity = classifierIdentity(message, hint, depth);
			if (depth < (classificationDepth.get(message) || 0)
			 || (identity && identity === lastIdentity.get(message))) {
				return;
			}
			identity && lastIdentity.set(message, identity);

			const itemSequence = ++sequence;
			latestSequence.set(message, itemSequence);
			const hintApplied = applyClassification(message, hint, depth, itemSequence);

			if (text && clampConfidence(hint.confidence) < RULE_CONFIDENCE_THRESHOLD) {
				const cached = identity ? cachedResult(identity) : null;
				if (cached) {
					applyClassification(message, cached, depth, itemSequence)
						&& persistAutomaticCategory(message, cached);
					return;
				}
				if (pending.size >= MAX_PENDING_ITEMS) {
					return;
				}
				const id = 'email-' + (++requestId);
				pending.set(id, { message, depth, sequence: itemSequence, cacheKey: identity });
				items.push({
					id,
					text,
					hintCategory: categorySet.has(hint.category) ? hint.category : 'other',
					hintConfidence: clampConfidence(hint.confidence)
				});
			} else if (hintApplied) {
				persistAutomaticCategory(message, hint);
			}
		});

		if (items.length) {
			workerQueue.push(...items);
			sendWorkerItems();
		}
	},

	requestKeyword = (message, keyword, setAction) => new Promise((resolve, reject) =>
		Remote.request('MessageSetKeyword', error => error ? reject(error) : resolve(), {
			folder: message.folder,
			uids: message.uid,
			keyword,
			setAction: setAction ? 1 : 0,
			strict: 1
		})
	),

	writeMessageCategory = async (message, category, automatic = false, retentionPolicy = '') => {
		if (!getFolderFromCacheList(message.folder)?.tagsAllowed()) {
			return false;
		}
		const before = message.flags().slice(),
			beforeLower = before.map(flag => flag.toLowerCase()),
			automaticFlag = before.find(flag => flag.toLowerCase() === AUTOMATIC_CATEGORY_FLAG),
			retentionFlags = before.filter(flag => Object.values(RETENTION_FLAGS).includes(flag.toLowerCase())),
			categoryFlags = before.filter(flag => {
				const value = flag.toLowerCase();
				return value.startsWith(CATEGORY_FLAG_PREFIX)
					&& categorySet.has(value.slice(CATEGORY_FLAG_PREFIX.length));
			}),
			nextFlag = category ? categoryKeyword(category) : '',
			hadAutomatic = !!automaticFlag,
			nextAutomatic = !!nextFlag && automatic,
			nextRetentionFlag = nextAutomatic ? retentionKeyword(retentionPolicy) : '';

		if (1 === categoryFlags.length && categoryFlags[0].toLowerCase() === nextFlag
		 && hadAutomatic === nextAutomatic
		 && retentionFlags.length === (nextRetentionFlag ? 1 : 0)
		 && (!nextRetentionFlag || retentionFlags[0].toLowerCase() === nextRetentionFlag)
		 || !categoryFlags.length && !nextFlag && !hadAutomatic && !retentionFlags.length) {
			return true;
		}

		const oldManagedFlags = categoryFlags.concat(automaticFlag ? [automaticFlag] : [], retentionFlags),
			nextManagedFlags = (nextFlag ? [nextFlag] : [])
				.concat(nextAutomatic ? [AUTOMATIC_CATEGORY_FLAG] : [], nextRetentionFlag ? [nextRetentionFlag] : []),
			addedFlags = nextManagedFlags.filter(flag => !beforeLower.includes(flag)),
			removedFlags = oldManagedFlags.filter(flag => !nextManagedFlags.includes(flag.toLowerCase()));
		message.flags(before.filter(flag => !oldManagedFlags.includes(flag)).concat(nextManagedFlags));
		try {
			// Set the new correction before removing the old one so a transient
			// failure cannot silently erase the user's last durable choice.
			for (const flag of addedFlags) {
				await requestKeyword(message, flag, true);
			}
			for (const flag of removedFlags) {
				await requestKeyword(message, flag, false);
			}
			return true;
		} catch (e) {
			message.flags(before);
			// Restore the last known durable state after any partially completed
			// multi-request replacement. These writes are intentionally idempotent.
			for (const flag of oldManagedFlags) {
				await requestKeyword(message, flag, true).catch(() => null);
			}
			for (const flag of addedFlags) {
				await requestKeyword(message, flag, false).catch(() => null);
			}
			return false;
		}
	},

	requestCategoryMove = (message, toFolder) => new Promise((resolve, reject) =>
		Remote.request('MessageMove', error => error ? reject(error) : resolve(), {
			fromFolder: message.folder,
			toFolder,
			uids: message.uid
		})
	),

	routeMessageCategory = async (message, category) => {
		if (message.folder !== getFolderInboxName() || !SMART_CATEGORY_VALUES.includes(category)) {
			return false;
		}
		const routes = parseCategoryFolderRoutes(SettingsUserStore.categoryFolderRoutes()),
			toFolder = routes[category],
			target = toFolder && getFolderFromCacheList(toFolder);
		if (!target?.selectable() || target.isSystemFolder() || toFolder === message.folder
		 || categoryRoutes.get(message) === toFolder) {
			return false;
		}
		categoryRoutes.set(message, toFolder);
		try {
			await requestCategoryMove(message, toFolder);
			fireEvent('mailbox.message.category-routed', {
				fromFolder: message.folder,
				message,
				toFolder
			});
			return true;
		} catch (e) {
			categoryRoutes.delete(message);
			return false;
		}
	},

	persistAutomaticCategory = (message, result) => {
		if (!automaticPersistenceAllowed(result) || message.manualCategory?.()) {
			return Promise.resolve(false);
		}
		const previous = categoryWrites.get(message) || Promise.resolve(),
			current = previous.then(() => {
				if (message.manualCategory?.()) {
					return false;
				}
				return writeMessageCategory(message, result.category, true, result.retentionPolicy);
			});
		categoryWrites.set(message, current);
		return current;
	};

export { CLASSIFIER_CATEGORIES, CLASSIFIER_CATEGORY_OPTIONS };

export function classifyMessagePage(messages) {
	classify(messages, false);
}

export function classifyOpenedMessage(message) {
	classify(message ? [message] : [], true);
}

export function setMessageCategory(message, category) {
	category = (category || '').toLowerCase();
	if (!message?.flags || category && !categorySet.has(category)) {
		return Promise.resolve(false);
	}
	const previous = categoryWrites.get(message) || Promise.resolve();
	const current = previous.then(async () => {
		const saved = await writeMessageCategory(message, category);
		if (!saved) {
			return false;
		}
		if (category) {
			await routeMessageCategory(message, category);
		} else {
			const result = {
				category: message.classifiedCategory?.(),
				confidence: message.classifiedCategoryConfidence?.(),
				source: message.classifiedCategorySource?.()
			};
			if (automaticPersistenceAllowed(result)) {
				await writeMessageCategory(message, result.category, true);
				await routeMessageCategory(message, result.category);
			}
		}
		return true;
	});
	categoryWrites.set(message, current);
	return current;
}
