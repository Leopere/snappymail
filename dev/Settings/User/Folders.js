import ko from 'ko';
import { koComputable } from 'External/ko';

import { Notifications } from 'Common/Enums';
import { FolderMetadataKeys } from 'Common/EnumsUser';
import { getNotification } from 'Common/Translator';

import { getFolderFromCacheList, removeFolderFromCacheList } from 'Common/Cache';
import { defaultOptionsAfterRender } from 'Common/Utils';
import { folderListOptionsBuilder } from 'Common/Folders';
import { initOnStartOrLangChange, i18n } from 'Common/Translator';

import { FolderUserStore } from 'Stores/User/Folder';
import { SettingsUserStore } from 'Stores/User/Settings';

import Remote from 'Remote/User/Fetch';

import { showScreenPopup } from 'Knoin/Knoin';

//import { FolderPopupView } from 'View/Popup/Folder';
import { FolderCreatePopupView } from 'View/Popup/FolderCreate';
import { FolderSystemPopupView } from 'View/Popup/FolderSystem';
import {
	SMART_CATEGORY_OPTIONS,
	parseCategoryFolderRoutes,
	serializeCategoryFolderRoutes
} from 'Classifier/Categories';
import { setupCategoryFolders } from 'Classifier/CategoryFolders';
import { setupSmartArchiveFolders } from 'Classifier/SmartArchiveSetup';

const folderForDeletion = ko.observable(null).askDeleteHelper();

export class UserSettingsFolders /*extends AbstractViewSettings*/ {
	constructor() {
		this.showKolab = FolderUserStore.allowKolab();
		this.defaultOptionsAfterRender = defaultOptionsAfterRender;
		this.kolabTypeOptions = ko.observableArray();
		let i18nFilter = key => i18n('SETTINGS_FOLDERS/TYPE_' + key);
		initOnStartOrLangChange(()=>{
			this.kolabTypeOptions([
				{ id: '', name: '' },
				{ id: 'event', name: i18nFilter('CALENDAR') },
				{ id: 'contact', name: i18nFilter('CONTACTS') },
				{ id: 'task', name: i18nFilter('TASKS') },
				{ id: 'note', name: i18nFilter('NOTES') },
				{ id: 'file', name: i18nFilter('FILES') },
				{ id: 'journal', name: i18nFilter('JOURNAL') },
				{ id: 'configuration', name: i18nFilter('CONFIGURATION') }
			]);
		});

		this.displaySpecSetting = FolderUserStore.displaySpecSetting;
		this.folderList = FolderUserStore.folderList;
		this.folderListOptimized = FolderUserStore.optimized;
		this.folderListError = FolderUserStore.error;
		this.hideUnsubscribed = SettingsUserStore.hideUnsubscribed;
		this.unhideKolabFolders = SettingsUserStore.unhideKolabFolders;
		this.smartArchiveEnabled = SettingsUserStore.smartArchiveEnabled;

		this.loading = FolderUserStore.foldersChanging;
		this.smartArchiveSetupLoading = ko.observable(false);
		this.categorySetupLoading = ko.observable(false);
		this.categoryRoutesUpdating = false;
		const routes = parseCategoryFolderRoutes(SettingsUserStore.categoryFolderRoutes());
		this.categoryRoutes = SMART_CATEGORY_OPTIONS.map(option => ({
			...option,
			folder: ko.observable(routes[option.value] || '')
		}));
		this.categoryFolderOptions = koComputable(() => folderListOptionsBuilder(
			[],
			[['', i18n('SETTINGS_FOLDERS/CATEGORY_KEEP_IN_INBOX')]],
			folder => folder.detailedName(),
			folder => !folder.selectable() || folder.isSystemFolder()
		));
		this.categoryRoutes.forEach(route => route.folder.subscribe(() =>
			this.categoryRoutesUpdating || this.saveCategoryRoutes()
		));

		this.folderForDeletion = folderForDeletion;

		SettingsUserStore.hideUnsubscribed.subscribe(value => Remote.saveSetting('HideUnsubscribed', value));
		SettingsUserStore.unhideKolabFolders.subscribe(value => Remote.saveSetting('UnhideKolabFolders', value));
		SettingsUserStore.smartArchiveEnabled.subscribe(value => {
			Remote.saveSetting('SmartArchiveEnabled', value);
			value && this.autoConfigureSmartArchive();
		});
	}

	onShow() {
		FolderUserStore.error('');
	}

	saveCategoryRoutes() {
		const value = serializeCategoryFolderRoutes(Object.fromEntries(
			this.categoryRoutes.map(route => [route.value, route.folder()])
		));
		SettingsUserStore.categoryFolderRoutes(value);
		Remote.saveSetting('CategoryFolderRoutes', value);
	}

	async autoConfigureSmartArchive() {
		if (this.smartArchiveSetupLoading()) {
			return;
		}
		this.smartArchiveSetupLoading(true);
		const result = await setupSmartArchiveFolders();
		FolderUserStore.error(result.complete ? '' : i18n('SETTINGS_FOLDERS/SMART_ARCHIVE_SETUP_FAILED'));
		this.smartArchiveSetupLoading(false);
	}

	async autoConfigureCategoryFolders() {
		if (this.categorySetupLoading()) {
			return;
		}
		this.categorySetupLoading(true);
		const result = await setupCategoryFolders(true);
		this.categoryRoutesUpdating = true;
		this.categoryRoutes.forEach(route => route.folder(result.routes[route.value] || ''));
		this.categoryRoutesUpdating = false;
		FolderUserStore.error(result.complete ? '' : i18n('SETTINGS_FOLDERS/CATEGORY_SETUP_FAILED'));
		this.categorySetupLoading(false);
	}
/*
	onBuild(oDom) {
	}
*/
	createFolder() {
		showScreenPopup(FolderCreatePopupView);
	}

	systemFolder() {
		showScreenPopup(FolderSystemPopupView);
	}

	deleteFolder(folderToRemove) {
		if (folderToRemove
		 && folderToRemove.canBeDeleted()
		 && folderToRemove.askDelete()
		) {
			if (0 < folderToRemove.totalEmails()) {
//				FolderUserStore.error(getNotification(Notifications.CantDeleteNonEmptyFolder));
				folderToRemove.errorMsg(getNotification(Notifications.CantDeleteNonEmptyFolder));
			} else {
				folderForDeletion(null);

				if (folderToRemove) {
					Remote.abort('Folders').post('FolderDelete', FolderUserStore.foldersDeleting, {
							folder: folderToRemove.fullName
						}).then(
							() => {
//								folderToRemove.attributes.push('\\nonexistent');
								folderToRemove.selectable(false);
//								folderToRemove.isSubscribed(false);
//								folderToRemove.checkable(false);
								if (!folderToRemove.subFolders.length) {
									removeFolderFromCacheList(folderToRemove.fullName);
									const folder = getFolderFromCacheList(folderToRemove.parentName);
									(folder ? folder.subFolders : FolderUserStore.folderList).remove(folderToRemove);
								}
							},
							error => {
								FolderUserStore.error(
									getNotification(error.code, '', Notifications.CantDeleteFolder)
									+ '.\n' + error.message
								);
							}
						);
				}
			}
		}
	}

	hideError() {
		FolderUserStore.error('');
	}

	toggleFolderKolabType(folder, event) {
		let type = event.target.value;
		// TODO: append '.default' ?
		Remote.request('FolderSetMetadata', null, {
			folder: folder.fullName,
			key: FolderMetadataKeys.KolabFolderType,
			value: type
		});
		folder.kolabType(type);
	}

	toggleFolderSubscription(folder) {
		let subscribe = !folder.isSubscribed();
		Remote.request('FolderSubscribe', null, {
			folder: folder.fullName,
			subscribe: subscribe ? 1 : 0
		});
		folder.isSubscribed(subscribe);
	}

	toggleFolderCheckable(folder) {
		let checkable = !folder.checkable();
		Remote.request('FolderCheckable', null, {
			folder: folder.fullName,
			checkable: checkable ? 1 : 0
		});
		folder.checkable(checkable);
	}
}
