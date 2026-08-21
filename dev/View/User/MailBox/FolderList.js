import ko from 'ko';

import { ScopeFolderList, ScopeMessageList } from 'Common/Enums';
import { addShortcut, leftPanelDisabled, stopEvent } from 'Common/Globals';
import { mailBox, settings } from 'Common/Links';
import { addComputablesTo } from 'External/ko';
import { getNotification, i18n } from 'Common/Translator';

import { AppUserStore } from 'Stores/User/App';
import { SettingsUserStore } from 'Stores/User/Settings';
import { FolderUserStore } from 'Stores/User/Folder';
import { MessageUserStore } from 'Stores/User/Message';
import { MessagelistUserStore } from 'Stores/User/Messagelist';

import { showScreenPopup } from 'Knoin/Knoin';
import { AbstractViewLeft } from 'Knoin/AbstractViews';

import { showMessageComposer, moveAction } from 'Common/UtilsUser';
import { FolderCreatePopupView } from 'View/Popup/FolderCreate';
import { ContactsPopupView } from 'View/Popup/Contacts';
import { ComposePopupView } from 'View/Popup/Compose';

import { setExpandedFolder, foldersFilter } from 'Model/FolderCollection';
import { ThemeStore } from '../../../Stores/Theme';
import Remote from 'Remote/User/Fetch';

const isInboxView = folder => folder.isInbox()
	|| 'Snoozed' === folder.fullName
	|| FolderUserStore.archiveFolder() === folder.fullName;

export class MailFolderList extends AbstractViewLeft {
	constructor() {
		super();

//		this.oContentScrollable = null;

		this.composeInEdit = ComposePopupView.inEdit;

		this.moveAction = moveAction;

		this.allowContacts = AppUserStore.allowContacts();

		this.foldersFilter = foldersFilter;
		this.markSubfoldersReadLabel = i18n('FOLDER_LIST/MARK_SUBFOLDERS_READ');

		this.markingFolderTree = ko.observable('');

		addComputablesTo(this, {
			foldersFilterVisible: () => 20 < FolderUserStore.folderList().CountRec,

			inboxFolders: () => FolderUserStore.systemFolders().filter(isInboxView),

			mailFolders: () => FolderUserStore.systemFolders().filter(folder => !isInboxView(folder)),

			folderListVisible: () => {
				const result = [],
					systemNames = new Set(FolderUserStore.systemFoldersNames());
				FolderUserStore.folderList().visible().forEach(folder => {
					result.push(...(systemNames.has(folder.fullName)
						? folder.visibleSubfolders()
						: [folder]));
				});
				return result;
			}
		});
	}

	onBuild(dom) {
		const qs = s => dom.querySelector(s),
			eqs = (ev, s) => ev.target.closestWithin(s, dom);

		this.oContentScrollable = qs('.b-content');
		this.collapseSmartOnMobile();
		FolderUserStore.folderList.subscribe(() => this.collapseSmartOnMobile());

		dom.addEventListener('click', event => {
			let el = eqs(event, '.e-collapsed-sign');
			if (el) {
				const folder = ko.dataFor(el);
				if (folder) {
					const collapsed = folder.collapsed();
					setExpandedFolder(folder.fullName, collapsed);

					folder.collapsed(!collapsed);
					stopEvent(event);
					return;
				}
			}

			el = eqs(event, 'a');
			if (el?.matches('.selectable')) {
				event.preventDefault();
				const folder = ko.dataFor(el);
				if (folder) {
					if (moveAction()) {
						const copy = event.ctrlKey || 2 === moveAction(),
							messages = MessagelistUserStore.listCheckedOrSelectedUidsWithSubMails();
						moveAction(0);
						messages.size && MessagelistUserStore.moveMessages(
							messages.folder,
							messages,
							folder.fullName,
							copy
						);
					} else {
						if (!SettingsUserStore.usePreviewPane()) {
							MessageUserStore.message(null);
						}
/*
						if (folder.fullName === FolderUserStore.currentFolderFullName()) {
							setFolderETag(folder.fullName, '');
						}
*/
						let search = '';
						if (el.matches('.pinnedShortcut') && !folder.isFlagged()) {
							search = 'flagged';
						} else if (folder.unreadCount() && event.clientX > el.getBoundingClientRect().right - 25) {
							search = 'unseen';
						}
						hasher.setHash(mailBox(folder.fullNameHash, 1, search));

						// in mobile mode hide the panel when a folder is clicked
						ThemeStore.isMobile() && leftPanelDisabled(true);
					}

					AppUserStore.focusedState(ScopeMessageList);
				}
			}
		});

		addShortcut('arrowup,arrowdown', '', ScopeFolderList, event => {
			let items = [], index = 0;
			dom.querySelectorAll('li a').forEach(node => {
				if (node.offsetHeight || node.getClientRects().length) {
					items.push(node);
					if (node.matches('.focused')) {
						node.classList.remove('focused');
						index = items.length - 1;
					}
				}
			});
			if (items.length) {
				if ('ArrowUp' === event.key) {
					index && --index;
				} else if (index < items.length - 1) {
					++index;
				}
				items[index].classList.add('focused');
				this.scrollToFocused();
			}

			return false;
		});

		addShortcut('enter,open', '', ScopeFolderList, () => {
			const item = qs('li a.focused');
			if (item) {
				AppUserStore.focusedState(ScopeMessageList);
				item.click();
			}

			return false;
		});

		addShortcut('space', '', ScopeFolderList, () => {
			const item = qs('li a.focused'),
				folder = item && ko.dataFor(item);
			if (folder) {
				const collapsed = folder.collapsed();
				setExpandedFolder(folder.fullName, collapsed);
				folder.collapsed(!collapsed);
			}

			return false;
		});

//		addShortcut('tab', 'shift', ScopeFolderList, () => {
		addShortcut('escape,tab,arrowright', '', ScopeFolderList, () => {
			AppUserStore.focusedState(ScopeMessageList);
			moveAction(0);
			return false;
		});
	}

	collapseSmartOnMobile() {
		if (!ThemeStore.isMobile()) {
			return;
		}
		const smart = this.folderListVisible().find(folder => 'smart' === folder.name().toLowerCase());
		if (smart) {
			smart.collapsed(true);
			setExpandedFolder(smart.fullName, false);
		}
	}

	scrollToFocused() {
		const scrollable = this.oContentScrollable;
		if (scrollable) {
			let block, focused = scrollable.querySelector('li a.focused');
			if (focused) {
				const fRect = focused.getBoundingClientRect(),
					sRect = scrollable.getBoundingClientRect();
				if (fRect.top < sRect.top) {
					block = 'start';
				} else if (fRect.bottom > sRect.bottom) {
					block = 'end';
				}
				block && focused.scrollIntoView(block === 'start');
			}
		}
	}

	composeClick() {
		showMessageComposer();
	}

	markFolderTreeRead(folder, event) {
		stopEvent(event);
		if (!folder || this.markingFolderTree()) {
			return;
		}

		const targets = [];
		const collectUnread = item => {
			if (item.canBeSelected?.() && 0 < item.unreadEmails()) {
				targets.push(item);
			}
			item.subFolders?.().forEach(collectUnread);
		};
		collectUnread(folder);
		if (!targets.length) {
			return;
		}

		this.markingFolderTree(folder.fullName);
		Promise.all(targets.map(target => new Promise(resolve => {
			Remote.request('MessageSetSeenToAll', error => resolve({ error, target }), {
				folder: target.fullName,
				setAction: 1,
				threadUids: ''
			});
		}))).then(results => {
			const failed = results.filter(result => result.error),
				currentFolder = FolderUserStore.currentFolderFullName();
			results.forEach(result => result.error || result.target.unreadEmails(0));
			this.markingFolderTree('');

			if (results.some(result => !result.error && result.target.fullName === currentFolder)) {
				MessagelistUserStore.clearAllSelection(true);
				MessagelistUserStore.reload(false, true);
			}
			if (failed.length) {
				const detail = getNotification(failed[0].error);
				alert(i18n('FOLDER_LIST/MARK_SUBFOLDERS_READ_FAILED', {
					COUNT: failed.length
				}) + (detail ? '\n' + detail : ''));
			}
		});
	}

	clearFolderSearch() {
		foldersFilter('');
	}

	createFolder() {
		showScreenPopup(FolderCreatePopupView);
	}

	configureFolders() {
		hasher.setHash(settings('folders'));
	}

	contactsClick() {
		if (this.allowContacts) {
			showScreenPopup(ContactsPopupView);
		}
	}
}
