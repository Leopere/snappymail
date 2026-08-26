import { CLASSIFIER_CATEGORY_OPTIONS } from 'Classifier/Rules';

export const
	CATEGORY_FLAG_PREFIX = '$smcat-',
	AUTOMATIC_CATEGORY_FLAG = '$smcat-auto',
	RETENTION_FLAGS = Object.freeze({
		'auth-code-1d': '$smret-auth-code',
		'security-alert-30d': '$smret-security-alert'
	}),
	SMART_CATEGORY_VALUES = Object.freeze([
		'calendar',
		'contract',
		'finance',
		'security',
		'newsletter',
		'notification'
	]),
	SMART_CATEGORY_OPTIONS = Object.freeze(CLASSIFIER_CATEGORY_OPTIONS
		.filter(option => SMART_CATEGORY_VALUES.includes(option.value))
		.map(option => Object.freeze({
			...option,
			icon: {
				calendar: '📅',
				contract: '📝',
				finance: '🧾',
				security: '🛡',
				newsletter: '📰',
				notification: '🔔'
			}[option.value]
		}))),
	categoryKeyword = category => CATEGORY_FLAG_PREFIX + category,
	retentionKeyword = policy => RETENTION_FLAGS[policy] || '';

export function parseCategoryFolderRoutes(value) {
	const routes = {};
	try {
		value = 'string' === typeof value ? JSON.parse(value || '{}') : value;
		if (value && 'object' === typeof value && !Array.isArray(value)) {
			SMART_CATEGORY_VALUES.forEach(category => {
				const folder = value[category],
					hasControl = 'string' === typeof folder && [...folder]
						.some(character => 32 > character.charCodeAt(0) || 127 === character.charCodeAt(0));
				if ('string' === typeof folder && folder.length <= 512 && !hasControl) {
					folder && (routes[category] = folder);
				}
			});
		}
	} catch (e) {
		// Invalid settings leave routing disabled.
	}
	return routes;
}

export const serializeCategoryFolderRoutes = value => JSON.stringify(parseCategoryFolderRoutes(value));
