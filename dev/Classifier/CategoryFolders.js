import { getFolderFromCacheList } from 'Common/Cache';

import { loadFolders } from 'Model/FolderCollection';

import Remote from 'Remote/User/Fetch';

import { FolderUserStore } from 'Stores/User/Folder';
import { SettingsUserStore } from 'Stores/User/Settings';

import {
	SMART_CATEGORY_OPTIONS,
	parseCategoryFolderRoutes,
	serializeCategoryFolderRoutes
} from 'Classifier/Categories';

const aliases = Object.freeze({
	calendar: ['calendar', 'calendars', 'events', 'meetings'],
	contract: ['contracts', 'contract', 'agreements', 'signatures'],
	finance: ['finance', 'financial', 'billing', 'bills', 'invoices', 'receipts'],
	security: ['account alerts', 'security alerts', 'security'],
	newsletter: ['newsletters', 'newsletter', 'mailing lists', 'subscriptions'],
	notification: ['notifications', 'notification', 'automated updates']
});

let setupPromise = null;

const
	normalizeName = value => (value || '').normalize('NFKC').toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),

	folderName = folder => 'function' === typeof folder?.name ? folder.name() : folder?.name || '',

	allFolders = (folders = FolderUserStore.folderList(), result = []) => {
		(folders || []).forEach(folder => {
			result.push(folder);
			allFolders(folder.subFolders?.() || [], result);
		});
		return result;
	},

	isRouteTarget = folder => !!folder?.selectable?.()
		&& !folder.isSystemFolder?.()
		&& false !== folder.exists,

	discoverRoutes = (currentRoutes, categories) => {
		const folders = allFolders().filter(isRouteTarget),
			routes = {},
			used = new Set;

		SMART_CATEGORY_OPTIONS.forEach(option => {
			const current = currentRoutes[option.value],
				currentFolder = current && getFolderFromCacheList(current);
			if (isRouteTarget(currentFolder)) {
				routes[option.value] = currentFolder.fullName;
				used.add(currentFolder.fullName);
				return;
			}
			if (!categories.has(option.value)) {
				return;
			}
			const match = folders.find(folder => !used.has(folder.fullName)
				&& aliases[option.value].includes(normalizeName(folderName(folder))));
			if (match) {
				routes[option.value] = match.fullName;
				used.add(match.fullName);
			}
		});
		return routes;
	},

	nextFolderName = (label, takenNames) => {
		let name = label,
			index = 2;
		while (takenNames.has(normalizeName(name))) {
			name = label + ' (' + index++ + ')';
		}
		takenNames.add(normalizeName(name));
		return name;
	},

	createFolder = async (option, name, parent = '') => {
		try {
			const data = await Remote.post('FolderCreate', null, {
				folder: name,
				parent,
				subscribe: 1
			}, 5000);
			const folder = data.Result?.fullName || '';
			return folder ? { category: option?.value || '', folder } : null;
		} catch (error) {
			return null;
		}
	},

	createMissingFolders = async (routes, categories) => {
		const missing = SMART_CATEGORY_OPTIONS.filter(option =>
			categories.has(option.value) && !routes[option.value]
		);
		if (!missing.length) {
			return [];
		}

		const roots = FolderUserStore.folderList(),
			rootNames = new Set(roots.map(folder => normalizeName(folderName(folder)))),
			existingParent = allFolders().find(folder => 'categories' === normalizeName(folderName(folder))
				&& false !== folder.exists && false !== folder.subFolders?.allow);
		let parent = existingParent?.fullName || '';
		if (!parent && false !== roots.allow) {
			parent = (await createFolder(null, nextFolderName('Categories', rootNames)))?.folder || '';
		}

		const childNames = new Set((existingParent?.subFolders?.() || [])
			.map(folder => normalizeName(folderName(folder)))),
			created = parent ? (await Promise.all(missing.map(option =>
				createFolder(option, nextFolderName(option.label, childNames), parent)
			))).filter(Boolean) : [],
			createdCategories = new Set(created.map(item => item.category)),
			rootFallbacks = false === roots.allow ? []
				: missing.filter(option => !createdCategories.has(option.value));

		created.push(...(await Promise.all(rootFallbacks.map(option =>
			createFolder(option, nextFolderName(option.label, rootNames))
		))).filter(Boolean));
		return created;
	},

	reloadFolders = () => new Promise(resolve => loadFolders(success => resolve(!!success))),

	saveRoutes = routes => new Promise(resolve => {
		const value = serializeCategoryFolderRoutes(routes);
		SettingsUserStore.categoryFolderRoutes(value);
		Remote.saveSetting('CategoryFolderRoutes', value, error => resolve(!error));
	}),

	setup = async force => {
		const storedValue = SettingsUserStore.categoryFolderRoutes() || '',
			storedRoutes = parseCategoryFolderRoutes(storedValue),
			categories = new Set(force || !storedValue
				? SMART_CATEGORY_OPTIONS.map(option => option.value)
				: SMART_CATEGORY_OPTIONS.filter(option => storedRoutes[option.value]
					&& !isRouteTarget(getFolderFromCacheList(storedRoutes[option.value])))
					.map(option => option.value));
		if (!categories.size) {
			return { complete: true, routes: storedRoutes };
		}

		let routes = discoverRoutes(storedRoutes, categories);
		const created = await createMissingFolders(routes, categories);
		if (created.length) {
			await reloadFolders();
			routes = discoverRoutes(routes, categories);
			created.forEach(item => {
				const folder = getFolderFromCacheList(item.folder);
				isRouteTarget(folder) && (routes[item.category] = folder.fullName);
			});
		}

		const complete = [...categories].every(category => !!routes[category]);
		SettingsUserStore.categoryFolderRoutes(serializeCategoryFolderRoutes(routes));
		return {
			complete: complete && await saveRoutes(routes),
			routes
		};
	};

export function setupCategoryFolders(force = false) {
	if (!setupPromise) {
		setupPromise = setup(force)
			.catch(() => ({ complete: false, routes: {} }))
			.finally(() => setupPromise = null);
	}
	return setupPromise;
}
