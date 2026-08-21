import { getFolderFromCacheList } from 'Common/Cache';

import { loadFolders, setExpandedFolder } from 'Model/FolderCollection';

import Remote from 'Remote/User/Fetch';

import { FolderUserStore } from 'Stores/User/Folder';
import { ThemeStore } from 'Stores/Theme';

export const SMART_ARCHIVE_FOLDER_NAMES = Object.freeze([
	'Finance',
	'Newsletters',
	'Notifications',
	'Security'
]);

let setupPromise = null;

const
	normalizeName = value => (value || '').normalize('NFKC').toLowerCase().trim(),

	allFolders = (folders = FolderUserStore.folderList(), result = []) => {
		(folders || []).forEach(folder => {
			result.push(folder);
			allFolders(folder.subFolders?.() || [], result);
		});
		return result;
	},

	findRoot = name => FolderUserStore.folderList()
		.find(folder => normalizeName(folder.name?.()) === normalizeName(name)),

	findChild = (parentName, name) => allFolders().find(folder =>
		folder.parentName === parentName && normalizeName(folder.name?.()) === normalizeName(name)
	),

	createFolder = async (name, parent = '') => {
		try {
			const data = await Remote.post('FolderCreate', null, {
				folder: name,
				parent,
				subscribe: 1
			}, 5000);
			return data.Result?.fullName || '';
		} catch (error) {
			return '';
		}
	},

	subscribeFolder = folder => new Promise(resolve => {
		if (folder.isSubscribed?.()) {
			resolve(true);
			return;
		}
		Remote.request('FolderSubscribe', error => {
			if (!error) {
				folder.isSubscribed(true);
			}
			resolve(!error);
		}, {
			folder: folder.fullName,
			subscribe: 1
		});
	}),

	reloadFolders = () => new Promise(resolve => loadFolders(success => resolve(!!success))),

	collapseSmartOnMobile = folder => {
		if (folder && ThemeStore.isMobile()) {
			folder.collapsed(true);
			setExpandedFolder(folder.fullName, false);
		}
	},

	setup = async () => {
		let smart = findRoot('Smart'),
			smartName = smart?.fullName || '',
			archive = null,
			archiveName = '',
			created = false;

		if (!smartName) {
			archive = getFolderFromCacheList(FolderUserStore.archiveFolder()) || findRoot('Archive');
			archiveName = archive?.fullName || '';
			if (!archiveName && false !== FolderUserStore.folderList().allow) {
				archiveName = await createFolder('Archive');
				created = !!archiveName;
			}
			if (archiveName) {
				smart = findChild(archiveName, 'Smart');
				smartName = smart?.fullName || '';
				if (!smartName) {
					smartName = await createFolder('Smart', archiveName);
					created = created || !!smartName;
				}
			}
		}
		if (!smartName) {
			return { complete: false, folders: {} };
		}

		const existing = Object.fromEntries(SMART_ARCHIVE_FOLDER_NAMES.map(name => [
			name,
			findChild(smartName, name)?.fullName || ''
		]));
		const missing = SMART_ARCHIVE_FOLDER_NAMES.filter(name => !existing[name]);
		if (missing.length) {
			const names = await Promise.all(missing.map(name => createFolder(name, smartName)));
			names.forEach((fullName, index) => fullName && (existing[missing[index]] = fullName));
			created = created || names.some(Boolean);
		}

		if (created && !await reloadFolders()) {
			return { complete: false, folders: existing };
		}

		archive = archiveName
			? getFolderFromCacheList(archiveName) || findRoot('Archive')
			: null;
		smart = getFolderFromCacheList(smartName) || findRoot('Smart')
			|| findChild(archiveName, 'Smart');
		const folders = Object.fromEntries(SMART_ARCHIVE_FOLDER_NAMES.map(name => [
			name,
			findChild(smartName, name)
		]));
		const required = [archive, smart, ...Object.values(folders)].filter(Boolean),
			subscribed = await Promise.all(required.map(subscribeFolder));

		collapseSmartOnMobile(smart);

		return {
			complete: required.length === SMART_ARCHIVE_FOLDER_NAMES.length
				+ (archiveName ? 2 : 1)
				&& subscribed.every(Boolean),
			folders: Object.fromEntries(Object.entries(folders)
				.map(([name, folder]) => [name, folder?.fullName || existing[name] || '']))
		};
	};

export function setupSmartArchiveFolders() {
	if (!setupPromise) {
		setupPromise = setup()
			.catch(() => ({ complete: false, folders: {} }))
			.finally(() => setupPromise = null);
	}
	return setupPromise;
}
