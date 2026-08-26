const TEXT_BUDGET = 2048,
	TOPIC_PRECEDENCE = Object.freeze({
		calendar: 0,
		contract: 1,
		security: 2,
		finance: 3
	}),
	// eslint-disable-next-line max-len
	CALENDAR_SUBJECT = /\b(?:(?:meeting|event|calendar)\s+(?:invite|invitation)|(?:invite|invitation)\s+(?:to|for)\s+(?:a\s+)?(?:meeting|event))\b/i,
	CALENDAR_ACTION = /\b(?:invite|invitation|rsvp|response requested)\b/i,
	// eslint-disable-next-line max-len
	CONTRACT_SUBJECT = /\b(?:signature requested|signature needed|please (?:review (?:and|&) )?sign|awaiting (?:your )?signature|document (?:is )?(?:ready )?for (?:your )?signature|review (?:and|&) sign)\b/i,
	CONTRACT_DOCUMENT = /\b(?:contract|agreement|lease|waiver|nda|non[- ]disclosure)\b/i,
	// eslint-disable-next-line max-len
	FINANCE_DOCUMENT = /\b(?:invoice|receipt|statement|remittance|purchase[- ]?order|tax[- ]?(?:document|form)|payroll)\b/i,
	// eslint-disable-next-line max-len
	FINANCE_SUBJECT = /\b(?:invoice|payment (?:received|confirmed|failed|declined|due)|amount due|billing statement|account statement|remittance advice|purchase[- ]?order|refund (?:issued|processed)|tax (?:document|form)|payroll)\b/i,
	FINANCE_ACTION = /\b(?:past due|overdue|amount due|pay by|payment (?:failed|declined)|action required)\b/i,
	// eslint-disable-next-line max-len
	AUTH_CODE_SUBJECT = /\b(?:(?:(?:authentication|verification|security|sign[ -]?in|login|access|two[- ]factor|2fa)\s+(?:code|otp|passcode))|(?:one[- ]time (?:code|password|passcode))|(?:(?:code|otp|passcode)\s+(?:for|to)\s+(?:authenticate|verify|sign[ -]?in|log[ -]?in)))\b/i,
	// eslint-disable-next-line max-len
	SECURITY_ALERT_SUBJECT = /\b(?:security alert|unusual (?:sign[ -]?in|login|activity)|new (?:sign[ -]?in|login)|login notification|sign[ -]?in notification|password (?:reset|changed|expires)|account locked|suspicious activity)\b/i,
	// eslint-disable-next-line max-len
	SECURITY_SUBJECT = /\b(?:two[- ]factor|2fa|verify your (?:account|email|identity))\b/i,
	// eslint-disable-next-line max-len
	EXPLICIT_ACTION = /\b(?:(?:action|response|approval|signature) required|please (?:review|sign|approve|confirm|verify|respond))\b/i,
	ROCKSIGN_LINK = /https:\/\/sign\.boompay\.ca\/s\/[A-Za-z0-9_-]{8,}(?:[\s"'<>)]|$)/i,
	// eslint-disable-next-line max-len
	DOCUMENT_MIME = /^(?:application\/(?:pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.oasis\.opendocument\.text))\b/i,
	DOCUMENT_FILE = /\.(?:pdf|docx?|odt)$/i,
	REPORT_TYPE = /\breport-type\s*=\s*"?(?:delivery-status|disposition-notification)"?/i,
	REPORT_PART = /^(?:message\/(?:delivery-status|disposition-notification))\b/i,
	CALENDAR_MIME = /^text\/calendar\b/i,
	CALENDAR_FILE = /\.ics$/i;

export const CLASSIFIER_CATEGORIES = Object.freeze([
	'calendar',
	'contract',
	'finance',
	'security',
	'newsletter',
	'notification',
	'personal',
	'other'
]);

export const CLASSIFIER_CATEGORY_OPTIONS = Object.freeze([
	['calendar', 'Calendar'],
	['contract', 'Contracts'],
	['finance', 'Finance'],
	['security', 'Account alerts'],
	['newsletter', 'Newsletters'],
	['notification', 'Notifications'],
	['personal', 'Personal'],
	['other', 'Other']
].map(([value, label]) => Object.freeze({ value, label })));

const normalize = value => 'string' === typeof value
	? value.normalize('NFKC').replace(/\s+/g, ' ').trim()
	: '',
	headerValue = (headers, name) => {
		const lowerName = name.toLowerCase();
		if (Array.isArray(headers)) {
			const header = headers.find(item => item
				&& 'string' === typeof item.name
				&& lowerName === item.name.toLowerCase());
			return header && 'string' === typeof header.value ? header.value : '';
		}
		if (headers && 'object' === typeof headers) {
			const key = Object.keys(headers).find(item => lowerName === item.toLowerCase());
			return key && 'string' === typeof headers[key] ? headers[key] : '';
		}
		return '';
	},
	boundedMetadata = input => {
		let remaining = TEXT_BUDGET;
		const take = (value, maximum) => {
			const text = normalize(value).slice(0, Math.min(maximum, remaining));
			remaining -= text.length;
			return text;
		},
			headers = input && 'object' === typeof input ? input.headers : null,
			contentType = take(input?.contentType || headerValue(headers, 'Content-Type'), 192),
			autoSubmitted = take(headerValue(headers, 'Auto-Submitted'), 128),
			listId = take(headerValue(headers, 'List-Id'), 128),
			listUnsubscribe = take(headerValue(headers, 'List-Unsubscribe'), 128),
			precedence = take(headerValue(headers, 'Precedence'), 128),
			subject = take(input?.subject, 384),
			preview = take(input?.preview, 512),
			attachments = [];

		if (Array.isArray(input?.attachments)) {
			input.attachments.slice(0, 8).forEach(attachment => {
				if (attachment && 'object' === typeof attachment && remaining) {
					attachments.push({
						mimeType: take(attachment.mimeType, 96),
						fileName: take(attachment.fileName, 128)
					});
				}
			});
		}

		return { contentType, autoSubmitted, listId, listUnsubscribe, precedence, subject, preview, attachments };
	},
	result = (
		category,
		confidence,
		actionRequired = false,
		actionConfidence = 0,
		reasonCodes = [],
		retentionPolicy = ''
	) => Object.freeze({
		category,
		confidence,
		actionRequired,
		actionConfidence,
		source: 'rules',
		reasonCodes: Object.freeze([...new Set(reasonCodes)]),
		retentionPolicy
	}),
	isDocument = attachment => DOCUMENT_MIME.test(attachment.mimeType) || DOCUMENT_FILE.test(attachment.fileName),
	actionFor = (category, metadata, reasonCodes) => {
		const { subject, preview } = metadata;
		switch (category) {
			case 'calendar':
				return CALENDAR_ACTION.test(subject)
					? [true, 0.94, [...reasonCodes, 'action.calendar']]
					: [false, 0, reasonCodes];
			case 'contract':
				return ROCKSIGN_LINK.test(preview) || CONTRACT_SUBJECT.test(subject) || EXPLICIT_ACTION.test(subject)
					? [true, 0.96, [...reasonCodes, 'action.contract']]
					: [false, 0, reasonCodes];
			case 'finance':
				return FINANCE_ACTION.test(subject)
					? [true, 0.95, [...reasonCodes, 'action.finance']]
					: [false, 0, reasonCodes];
			case 'security': {
				const unusual = /\b(?:unusual|suspicious)\b/i.test(subject),
					review = /\b(?:review|verify|confirm)\b/i.test(subject),
					action = EXPLICIT_ACTION.test(subject)
						|| /\b(?:verify your|confirm your|reset your password|account locked|action required)\b/i.test(subject)
						|| (unusual && review);
				return action
					? [true, 0.94, [...reasonCodes, 'action.security']]
					: [false, 0, reasonCodes];
			}
			case 'notification':
				return EXPLICIT_ACTION.test(subject)
					? [true, 0.9, [...reasonCodes, 'action.notification']]
					: [false, 0, reasonCodes];
			default:
				return [false, 0, reasonCodes];
		}
	};

export function classifyMessageMetadata(input) {
	const metadata = boundedMetadata(input),
		{ contentType, subject, preview, attachments } = metadata,
		report = (/^multipart\/report\b/i.test(contentType) && REPORT_TYPE.test(contentType))
			|| attachments.some(attachment => REPORT_PART.test(attachment.mimeType));

	if (report) {
		return result('notification', 1, false, 0, ['mime.report']);
	}

	let best = null;
	const offer = (category, confidence, reasonCode) => {
		const precedence = TOPIC_PRECEDENCE[category];
		if (!best || confidence > best.confidence
			|| (confidence === best.confidence && precedence < best.precedence)) {
			best = { category, confidence, precedence, reasonCodes: [reasonCode] };
		} else if (best.category === category && !best.reasonCodes.includes(reasonCode)) {
			best.reasonCodes.push(reasonCode);
		}
	};

	if (CALENDAR_MIME.test(contentType) || attachments.some(attachment =>
		CALENDAR_MIME.test(attachment.mimeType) || CALENDAR_FILE.test(attachment.fileName))) {
		offer('calendar', 0.99, 'mime.calendar');
	} else if (CALENDAR_SUBJECT.test(subject)) {
		offer('calendar', 0.88, 'subject.calendar');
	}

	if (ROCKSIGN_LINK.test(preview)) {
		offer('contract', 0.99, 'link.rocksign');
	}
	if (CONTRACT_SUBJECT.test(subject)) {
		offer('contract', 0.96, 'subject.signing');
	}
	if (attachments.some(attachment => isDocument(attachment)
		&& (CONTRACT_DOCUMENT.test(subject) || CONTRACT_DOCUMENT.test(attachment.fileName)))) {
		offer('contract', 0.94, 'document.contract');
	}

	if (attachments.some(attachment => isDocument(attachment)
		&& (FINANCE_DOCUMENT.test(subject) || FINANCE_DOCUMENT.test(attachment.fileName)))) {
		offer('finance', 0.95, 'document.finance');
	}
	if (FINANCE_SUBJECT.test(subject)) {
		offer('finance', 0.92, 'subject.finance');
	}

	if (AUTH_CODE_SUBJECT.test(subject)) {
		offer('security', 0.99, 'subject.auth-code');
	} else if (SECURITY_ALERT_SUBJECT.test(subject)) {
		offer('security', 0.96, 'subject.security-alert');
	} else if (SECURITY_SUBJECT.test(subject)) {
		offer('security', 0.93, 'subject.security');
	}

	if (best) {
		const [actionRequired, actionConfidence, reasonCodes] = actionFor(best.category, metadata, best.reasonCodes);
		const retentionPolicy = reasonCodes.includes('subject.auth-code')
			? 'auth-code-1d'
			: reasonCodes.includes('subject.security-alert') ? 'security-alert-30d' : '';
		return result(best.category, best.confidence, actionRequired, actionConfidence, reasonCodes, retentionPolicy);
	}

	if (metadata.listId || metadata.listUnsubscribe) {
		const confidence = metadata.listId && /(?:^|[\s,])list(?:$|[\s,])/i.test(metadata.precedence) ? 0.96 : 0.92;
		return result('newsletter', confidence, false, 0, ['header.list']);
	}

	if (metadata.autoSubmitted && 'no' !== metadata.autoSubmitted.toLowerCase()) {
		const [actionRequired, actionConfidence, reasonCodes] = actionFor('notification', metadata, ['header.auto']);
		return result('notification', 0.97, actionRequired, actionConfidence, reasonCodes);
	}

	if (/\b(?:bulk|auto[_-]?reply)\b/i.test(metadata.precedence)
		&& /\b(?:notification|alert|update|status|report|failed|completed)\b/i.test(subject)) {
		const [actionRequired, actionConfidence, reasonCodes] = actionFor('notification', metadata, ['header.precedence']);
		return result('notification', 0.9, actionRequired, actionConfidence, reasonCodes);
	}

	return result('other', 0);
}
