import ko from 'ko';
import { addObservablesTo, addComputablesTo } from 'External/ko';

import { UNUSED_OPTION_VALUE } from 'Common/Consts';
import { ScopeFolderList, ScopeMessageList, ScopeMessageView } from 'Common/Enums';
import { ComposeType, FolderType, MessageSetAction } from 'Common/EnumsUser';
import { doc,
	leftPanelDisabled, toggleLeftPanel,
	Settings, SettingsCapa,
	addEventsListeners, stopEvent, fireEvent,
	addShortcut, registerShortcut, formFieldFocused
} from 'Common/Globals';
import { arrayLength } from 'Common/Utils';
import { computedPaginatorHelper, showMessageComposer, populateMessageBody, downloadZip, moveAction } from 'Common/UtilsUser';
import { FileInfo, RFC822 } from 'Common/File';
import { isFullscreen, toggleFullscreen } from 'Common/Fullscreen';

import { mailBox } from 'Common/Links';
import { Selector } from 'Common/Selector';

import { i18n } from 'Common/Translator';

import { dropFilesInFolder } from 'Common/Folders';

import { getFolderInboxName } from 'Common/Cache';

import { AppUserStore } from 'Stores/User/App';
import { SettingsUserStore } from 'Stores/User/Settings';
import { FolderUserStore } from 'Stores/User/Folder';
import { LanguageStore } from 'Stores/Language';
import { MessageUserStore } from 'Stores/User/Message';
import { MessagelistUserStore } from 'Stores/User/Messagelist';
import { ThemeStore } from 'Stores/Theme';

import { decorateKoCommands, showScreenPopup, arePopupsVisible } from 'Knoin/Knoin';
import { AbstractViewRight } from 'Knoin/AbstractViews';

import { FolderClearPopupView } from 'View/Popup/FolderClear';
import { AdvancedSearchPopupView } from 'View/Popup/AdvancedSearch';
import { ComposePopupView } from 'View/Popup/Compose';

import { MessageModel } from 'Model/Message';

import { LayoutSideView, ClientSideKeyNameMessageListSize } from 'Common/EnumsUser';
import { setLayoutResizer } from 'Common/UtilsUser';

export const classifyMessageSwipe = (distance, width) => {
	const
		magnitude = Math.abs(distance),
		shortThreshold = Math.min(72, width * 0.22),
		longThreshold = Math.min(200, width * 0.55);

	if (magnitude < shortThreshold) {
		return '';
	}
	if (0 < distance) {
		return magnitude >= longThreshold ? 'snooze' : 'archive';
	}
	return magnitude >= longThreshold ? 'spam' : 'delete';
};

export const classifyMessageSwipeIntent = (horizontalDistance, verticalDistance) => {
	const startSlop = 18;
	if (startSlop <= verticalDistance && horizontalDistance <= verticalDistance) {
		return 'vertical';
	}
	return startSlop <= horizontalDistance && horizontalDistance >= verticalDistance * 1.5
		? 'horizontal'
		: '';
};

export const projectMessageSwipe = (distance, direction) =>
	direction * Math.max(0, distance * direction - 18);

const
	canBeMovedHelper = () => MessagelistUserStore.hasCheckedOrSelected()
		&& !MessagelistUserStore.allSelectionLoading()
		&& !MessagelistUserStore.mutationLoading(),
	canUseMessageObjectsHelper = () => canBeMovedHelper()
		&& !MessagelistUserStore.allSelected(),
	currentFolderLabel = () => FolderUserStore.currentFolder()?.localName?.()
		|| FolderUserStore.currentFolderFullName(),

	/**
	 * @param {string} sFolderFullName
	 * @param {number} iSetAction
	 * @param {Array=} aMessages = null
	 * @returns {void}
	 */
	listAction = (...args) => MessagelistUserStore.setAction(...args),

	moveMessagesToFolderType = (toFolderType, bDelete) => {
		let messages = MessagelistUserStore.listCheckedOrSelectedUidsWithSubMails();
		messages.size && rl.app.moveMessagesToFolderType(
			toFolderType,
			messages.folder,
			messages,
			bDelete
		)
	},

	pad2 = v => 10 > v ? '0' + v : '' + v,
	Ymd = dt => dt.getFullYear() + pad2(1 + dt.getMonth()) + pad2(dt.getDate()),

	setMessage = msg => {
		populateMessageBody(msg);
/* This will replace url hash, and then load message
 * It's working properly yet
//		let hash = msg.href;
		let hash = mailBox(
			msg.folder,
			MessagelistUserStore.page(),
			MessagelistUserStore.listSearch(),
			MessagelistUserStore.threadUid(),
			msg.uid
		);
		MessageUserStore.message() ? hasher.replaceHash(hash) : hasher.setHash(hash);
*/
	};


let
	sLastSearchValue = '';

export class MailMessageList extends AbstractViewRight {
	constructor() {
		super();

		this.allowDangerousActions = SettingsCapa('DangerousActions');

		this.messageList = MessagelistUserStore;
		this.archiveAllowed = MessagelistUserStore.archiveAllowed;
		this.canMarkAsSpam = MessagelistUserStore.canMarkAsSpam;
		this.isSpamFolder = MessagelistUserStore.isSpamFolder;

		this.composeInEdit = ComposePopupView.inEdit;

		this.isMobile = ThemeStore.isMobile; // Obsolete

		this.popupVisibility = arePopupsVisible;

		this.useCheckboxesInList = SettingsUserStore.useCheckboxesInList;

		this.userUsageProc = FolderUserStore.quotaPercentage;

		this.hideDeleted = SettingsUserStore.hideDeleted;
		this.smartArchiveEnabled = SettingsUserStore.smartArchiveEnabled;
		this.deliveryReceiptLabel = i18n('MESSAGE_LIST/DELIVERY_RECEIPT_RECEIVED');
		this.readReceiptLabel = i18n('MESSAGE_LIST/READ_RECEIPT_RECEIVED');
		this.pendingSwipeAction = null;

		addObservablesTo(this, {
			focusSearch: false,
			swipeUndoVisible: false,
			swipeUndoText: ''
		});

		// append drag and drop
		this.dragOver = ko.observable(false).extend({ throttle: 1 });
		this.dragOverEnter = ko.observable(false).extend({ throttle: 1 });

		const attachmentsActions = Settings.app('attachmentsActions');
		this.attachmentsActions = ko.observableArray(arrayLength(attachmentsActions) ? attachmentsActions : []);

		addComputablesTo(this, {
			sortSupported: () => FolderUserStore.hasCapability('SORT') && !MessagelistUserStore.threadUid(),

			messageListSearchDesc: () => {
				const value = MessagelistUserStore().search;
				return value ? i18n('MESSAGE_LIST/SEARCH_RESULT_FOR', { SEARCH: value }) : ''
			},

			messageListPaginator: computedPaginatorHelper(MessagelistUserStore.page, MessagelistUserStore.pageCount),

			checkAll: {
				read: () => {
					const length = MessagelistUserStore().length;
					return !!length && MessagelistUserStore.listChecked().length === length;
				},
				write: (value) => {
					value = !!value;
					MessagelistUserStore.clearAllSelection();
					MessagelistUserStore.forEach(message => message.checked(value));
				}
			},

			inputSearch: {
				read: MessagelistUserStore.mainSearch,
				write: value => sLastSearchValue = value
			},

			isIncompleteChecked: () => {
				const c = MessagelistUserStore.listChecked().length;
				return !MessagelistUserStore.allSelected() && c && MessagelistUserStore().length > c;
			},

			selectAllInViewVisible: () => {
				const
					length = MessagelistUserStore().length,
					checked = MessagelistUserStore.listChecked().length;
				return !MessagelistUserStore.allSelected()
					&& !MessagelistUserStore.allSelectionLoading()
					&& length
					&& checked === length
					&& MessagelistUserStore.count() > length;
			},

			pageSelectionText: () => i18n('MESSAGE_LIST/PAGE_SELECTED', {
				COUNT: MessagelistUserStore.listChecked().length
			}, 'All %COUNT% messages on this page are selected.'),

			selectAllInViewText: () => i18n('MESSAGE_LIST/SELECT_ALL_IN_VIEW', {
				COUNT: MessagelistUserStore.count(),
				FOLDER: currentFolderLabel()
			}, 'Select all %COUNT% messages in %FOLDER%'),

			allSelectionText: () => i18n('MESSAGE_LIST/ALL_SELECTED', {
				COUNT: MessagelistUserStore.selectedCount(),
				FOLDER: currentFolderLabel()
			}, 'All %COUNT% messages in %FOLDER% are selected.'),

			selectingAllText: () => i18n('MESSAGE_LIST/SELECTING_ALL', null, 'Selecting all messages...'),

			clearSelectionText: () => i18n('MESSAGE_LIST/CLEAR_SELECTION', null, 'Clear selection'),

			listGrouped: () => {
				let uid = MessagelistUserStore.threadUid(),
					sort = FolderUserStore.sortMode() || 'DATE';
				return SettingsUserStore.listGrouped() && (sort.includes('DATE') || sort.includes('FROM')) && !uid;
			},

			timeFormat: () => (FolderUserStore.sortMode() || '').includes('FROM') ? 'AUTO' : 'LT',

			groupedList: () => {
				let list = [], current, sort = FolderUserStore.sortMode() || 'DATE';
				if (sort.includes('FROM')) {
					MessagelistUserStore.forEach(msg => {
						let email = msg.from[0]?.email;
						if (!current || email != current.id) {
							current = {
								id: email,
								label: msg.from[0]?.toLine(),
								search: 'from=' + email,
								messages: []
							};
							list.push(current);
						}
						current.messages.push(msg);
					});
				} else if (sort.includes('DATE')) {
					let today = Ymd(new Date()),
						rtf = Intl.RelativeTimeFormat
							? new Intl.RelativeTimeFormat(doc.documentElement.lang, { numeric: "auto" }) : 0;
					MessagelistUserStore.forEach(msg => {
						let dt = (new Date(msg.dateTimestamp() * 1000)),
							date,
							ymd = Ymd(dt);
						if (!current || ymd != current.id) {
							if (rtf && today == ymd) {
								date = rtf.format(0, 'day');
							} else if (rtf && today - 1 == ymd) {
								date = rtf.format(-1, 'day');
//							} else if (today - 7 < ymd) {
//								date = dt.format({weekday: 'long'});
//								date = dt.format({dateStyle: 'full'},0,LanguageStore.hourCycle());
							} else {
//								date = dt.format({dateStyle: 'medium'},0,LanguageStore.hourCycle());
								date = dt.format({dateStyle: 'full'},0,LanguageStore.hourCycle());
							}
							current = {
								id: ymd,
								label: date,
								search: 'on=' + dt.getFullYear() + '-' + pad2(1 + dt.getMonth()) + '-' + pad2(dt.getDate()),
								messages: []
							};
							list.push(current);
						}
						current.messages.push(msg);
					});
				}
				return list;
			},

			sortText: () => {
				let mode = FolderUserStore.sortMode(),
					has = w => mode.includes(w),
					desc = '' === mode || has('REVERSE');
				mode = mode.split(/\s+/);
				if (has('FROM')) {
					 return '@' + (desc ? '⬆' : '⬇');
				}
				if (has('SUBJECT')) {
					 return '𝐒' + (desc ? '⬆' : '⬇');
				}
				if (has('SIZE')) {
					 return '✉' + (desc ? '⬇' : '⬆');
				}
				return (has('ARRIVAL') ? '📨' : '📅') + (desc ? '⬇' : '⬆');
			},

			downloadAsZipAllowed: () => this.attachmentsActions.includes('zip')
		});

		this.selector = new Selector(
			MessagelistUserStore,
			MessagelistUserStore.selectedMessage,
			MessagelistUserStore.focusedMessage,
			'.messageListItem',
			'.messageListItem .messageCheckbox'
		);

		this.selector.on('ItemSelect', message => {
			if (message) {
//				setMessage(message.clone());
				setMessage(message);
			} else {
				MessageUserStore.message(null);
			}
		});

		this.selector.on('MiddleClick', message => populateMessageBody(message, true));

		this.selector.on('ItemGetUid', message => (message ? message.folder + '/' + message.uid : ''));

		this.selector.on('canSelect', () => MessagelistUserStore.canSelect());

		this.selector.on('click', (event, currentMessage) => {
			const el = event.target;
			if (el.closest('.flagParent')) {
				if (currentMessage) {
					const checked = MessagelistUserStore.listCheckedOrSelected();
					listAction(
						currentMessage.folder,
						currentMessage.isFlagged() ? MessageSetAction.UnsetFlag : MessageSetAction.SetFlag,
						checked.find(message => message.uid == currentMessage.uid) ? checked : [currentMessage]
					);
				}
			} else if (el.closest('.threads-len')) {
				this.gotoThread(currentMessage);
			} else if (el.closest('.messageCheckbox')) {
				// Selector toggles the checkbox after this callback.
			} else if (ThemeStore.isMobile() && MessagelistUserStore.hasChecked()
				&& currentMessage) {
				currentMessage.checked(!currentMessage.checked());
			} else {
				return 1;
			}
		});

		this.selector.on('UpOrDown', up => {
			if (!MessagelistUserStore.hasChecked()) {
				up = up ? -1 : 1;
				const page = MessagelistUserStore.page() + up;
				if (page > 0 && page <= MessagelistUserStore.pageCount()) {
					if (SettingsUserStore.usePreviewPane() || MessageUserStore.message()) {
						this.selector.iSelectNextHelper = up;
					} else {
						this.selector.iFocusedNextHelper = up;
					}
					this.selector.unselect();
					this.gotoPage(page);
				}
			}
		});

		addEventListener('mailbox.message-list.selector.go-down',
			e => this.selector.newSelectPosition('ArrowDown', false, e.detail)
		);

		addEventListener('mailbox.message-list.selector.go-up',
			e => this.selector.newSelectPosition('ArrowUp', false, e.detail)
		);

		addEventListener('mailbox.message.show', e => {
			const sFolder = e.detail.folder, iUid = e.detail.uid;

			const message = MessagelistUserStore.find(
				item => sFolder === item?.folder && iUid == item?.uid
			);

			if ('INBOX' === sFolder) {
				hasher.setHash(mailBox(sFolder));
			}

			if (message) {
				this.selector.selectMessageItem(message);
			} else {
				if ('INBOX' !== sFolder) {
					hasher.setHash(mailBox(sFolder));
				}
				if (sFolder && iUid) {
					let message = new MessageModel;
					message.folder = sFolder;
					message.uid = iUid;
					setMessage(message);
				} else {
					MessageUserStore.message(null);
				}
			}
		});

		MessagelistUserStore.endHash.subscribe((() =>
			this.selector.scrollToFocused()
		).throttle(50));

		decorateKoCommands(this, {
			downloadAttachCommand: canUseMessageObjectsHelper,
			downloadZipCommand: canUseMessageObjectsHelper,
			forwardCommand: canUseMessageObjectsHelper,
			deleteWithoutMoveCommand: canBeMovedHelper,
			deleteCommand: () => canBeMovedHelper() && MessagelistUserStore.hasCheckedOrSelectedAndUndeleted(),
			undeleteCommand: () => canBeMovedHelper() && MessagelistUserStore.hasCheckedOrSelectedAndDeleted(),
			archiveCommand: canBeMovedHelper,
			spamCommand: canBeMovedHelper,
			notSpamCommand: canBeMovedHelper,
			moveCommand: canBeMovedHelper,
			copyCommand: canBeMovedHelper
		});
	}

	changeSort(self, event) {
		FolderUserStore.sortMode(event.target.closest('li').dataset.sort);
		this.reload();
	}

	clearListIsVisible() {
		return (
			!this.messageListSearchDesc()
		 && !MessagelistUserStore.error()
		 && !MessagelistUserStore.endThreadUid()
		 && MessagelistUserStore().length
		 && (MessagelistUserStore.isSpamFolder() || MessagelistUserStore.isTrashFolder())
		 && SettingsCapa('DangerousActions')
		);
	}

	clear() {
		SettingsCapa('DangerousActions')
		&& showScreenPopup(FolderClearPopupView, [FolderUserStore.currentFolder()]);
	}

	selectAllInView() {
		MessagelistUserStore.selectAllInView();
	}

	clearSelection() {
		MessagelistUserStore.clearAllSelection(true);
	}

	messageUidsWithSubMails(message) {
		const uids = new Set;
		if (message) {
			uids.add(message.uid);
			1 < message.threadsLen() && message.threads().forEach(uids.add, uids);
			uids.folder = message.folder;
		}
		return uids;
	}

	moveMessageToFolderType(message, folderType) {
		const uids = this.messageUidsWithSubMails(message);
		uids.size && rl.app.moveMessagesToFolderType(folderType, uids.folder, uids);
	}

	queueMessageMove(message, row, folderType, text, setDeleted = false, permanentDelete = false) {
		this.commitPendingSwipeAction();
		const action = {
			folderType: folderType,
			message: message,
			permanentDelete: permanentDelete,
			row: row,
			setDeleted: setDeleted
		};
		row?.classList.add('swipe-pending');
		this.pendingSwipeAction = action;
		this.swipeUndoText(text);
		this.swipeUndoVisible(true);
		action.timer = setTimeout(() => this.commitPendingSwipeAction(), 5000);
	}

	commitPendingSwipeAction() {
		const action = this.pendingSwipeAction;
		if (!action) {
			return;
		}
		clearTimeout(action.timer);
		this.pendingSwipeAction = null;
		this.swipeUndoVisible(false);
		const move = attempts => {
			if (!MessagelistUserStore.mutationLoading()) {
				if (action.setDeleted) {
					action.row?.classList.remove('swipe-pending');
					listAction(action.message.folder, MessageSetAction.SetDeleted, [action.message]);
				} else if (action.permanentDelete) {
					const uids = this.messageUidsWithSubMails(action.message);
					uids.size && MessagelistUserStore.moveMessages(uids.folder, uids);
				} else {
					this.moveMessageToFolderType(action.message, action.folderType);
				}
			} else if (attempts) {
				setTimeout(() => move(attempts - 1), 250);
			} else {
				action.row?.classList.remove('swipe-pending');
				MessagelistUserStore.reload(false, true);
			}
		};
		move(40);
	}

	undoSwipeAction() {
		const action = this.pendingSwipeAction;
		if (!action) {
			return;
		}
		clearTimeout(action.timer);
		action.row?.classList.remove('swipe-pending');
		this.pendingSwipeAction = null;
		this.swipeUndoVisible(false);
	}

	archiveMessage(message, row) {
		this.archiveAllowed() && this.queueMessageMove(
			message, row, FolderType.Archive, i18n('MESSAGE_LIST/DONE_PENDING')
		);
	}

	spamMessage(message, row) {
		this.canMarkAsSpam() && this.queueMessageMove(
			message, row, FolderType.Junk, i18n('MESSAGE_LIST/SPAM_PENDING')
		);
	}

	deleteMessage(message, row) {
		if (!message) {
			return;
		}
		const
			trashFolder = FolderUserStore.trashFolder(),
			setDeleted = UNUSED_OPTION_VALUE === trashFolder,
			permanentDelete = !setDeleted && [trashFolder, FolderUserStore.spamFolder()].includes(message.folder);
		this.queueMessageMove(
			message, row, setDeleted ? 0 : FolderType.Trash,
			i18n('MESSAGE_LIST/DELETE_PENDING'), setDeleted, permanentDelete
		);
	}

	snoozeMessage(message) {
		const uids = this.messageUidsWithSubMails(message);
		message && fireEvent('mailbox.message.snooze-request', {
			folder: message.folder,
			message: message,
			uid: message.uid,
			uids: [...uids]
		});
	}

	reload() {
		MessagelistUserStore.isLoading()
		|| MessagelistUserStore.reload(false, true);
	}

	forwardCommand() {
		showMessageComposer([
			ComposeType.ForwardAsAttachment,
			MessagelistUserStore.listCheckedOrSelected()
		]);
	}

	/**
	 * Download selected messages
	 */
	downloadZipCommand() {
		let hashes = []/*, uids = []*/;
//		MessagelistUserStore.forEach(message => message.checked() && uids.push(message.uid));
		MessagelistUserStore.forEach(message => message.checked() && hashes.push(message.requestHash));
		downloadZip(null, hashes, null, null, MessagelistUserStore().folder);
	}

	/**
	 * Download attachments of selected messages
	 */
	downloadAttachCommand() {
		let hashes = [];
		MessagelistUserStore.forEach(message => {
			if (message.checked()) {
				message.attachments.forEach(attachment => {
					if (!attachment.isLinked() && attachment.download) {
						hashes.push(attachment.download);
					}
				});
			}
		});
		downloadZip(null, hashes);
	}

	deleteWithoutMoveCommand() {
		SettingsCapa('DangerousActions')
		&& moveMessagesToFolderType(FolderType.Trash, true);
	}

	// User setting hideDeleted || immediatelyMoveToTrash ??
	deleteCommand() {
		/**
		 * When FolderUserStore.trashFolder is set to "Do not use",
		 * flag as \Deleted for removal by later EXPUNGE
		 */
		if (UNUSED_OPTION_VALUE === FolderUserStore.trashFolder()) {
			listAction(
				FolderUserStore.currentFolderFullName(),
				MessageSetAction.SetDeleted,
				MessagelistUserStore.listCheckedOrSelected()
			);
		} else {
			moveMessagesToFolderType(FolderType.Trash);
		}
	}

	// User setting !hideDeleted && !immediatelyMoveToTrash ??
	undeleteCommand() {
		listAction(
			FolderUserStore.currentFolderFullName(),
			MessageSetAction.UnsetDeleted,
			MessagelistUserStore.listCheckedOrSelected()
		);
	}

	archiveCommand() {
		moveMessagesToFolderType(FolderType.Archive);
	}

	spamCommand() {
		moveMessagesToFolderType(FolderType.Junk);
	}

	notSpamCommand() {
		moveMessagesToFolderType(FolderType.Inbox);
	}

	moveOrCopy(vm, event, mode) {
		if (canBeMovedHelper()) {
			if (vm && event?.preventDefault) {
				stopEvent(event);
			}

			let i = moveAction();
			AppUserStore.focusedState(i ? ScopeMessageList : ScopeFolderList);
			moveAction(i ? 0 : mode);
		}
	}

	moveCommand(vm, event) {
		this.moveOrCopy(vm, event, 1);
	}

	copyCommand(vm, event) {
		this.moveOrCopy(vm, event, 2);
	}

	composeClick() {
		showMessageComposer();
	}

	cancelSearch() {
		MessagelistUserStore.mainSearch('');
		this.focusSearch(false);
	}

	cancelThreadUid() {
		// history.go(-1) better?
		hasher.setHash(
			mailBox(
				FolderUserStore.currentFolderFullNameHash(),
				MessagelistUserStore.pageBeforeThread(),
				MessagelistUserStore.listSearch()
			)
		);
	}

	listSetSeen() {
		listAction(
			FolderUserStore.currentFolderFullName(),
			MessageSetAction.SetSeen,
			MessagelistUserStore.listCheckedOrSelected()
		);
	}

	listSetAllSeen() {
		const
			folderName = FolderUserStore.currentFolderFullName(),
			threadUid = MessagelistUserStore.endThreadUid();
		MessagelistUserStore.setAllSeen(folderName, threadUid
			? MessagelistUserStore.map(message => message.uid)
			: []);
	}

	listUnsetSeen() {
		listAction(
			FolderUserStore.currentFolderFullName(),
			MessageSetAction.UnsetSeen,
			MessagelistUserStore.listCheckedOrSelected()
		);
	}

	listSetFlags() {
		listAction(
			FolderUserStore.currentFolderFullName(),
			MessageSetAction.SetFlag,
			MessagelistUserStore.listCheckedOrSelected()
		);
	}

	listUnsetFlags() {
		listAction(
			FolderUserStore.currentFolderFullName(),
			MessageSetAction.UnsetFlag,
			MessagelistUserStore.listCheckedOrSelected()
		);
	}

	seenMessagesFast(seen) {
		const checked = MessagelistUserStore.listCheckedOrSelected();
		if (checked.length || MessagelistUserStore.allSelected()) {
			listAction(
				checked[0]?.folder || FolderUserStore.currentFolderFullName(),
				seen ? MessageSetAction.SetSeen : MessageSetAction.UnsetSeen,
				checked
			);
		}
	}

	gotoPage(page) {
		page && hasher.setHash(
			mailBox(
				FolderUserStore.currentFolderFullNameHash(),
				page,
				MessagelistUserStore.listSearch(),
				MessagelistUserStore.threadUid()
			)
		);
	}

	gotoThread(message) {
		if (message?.threadsLen()) {
			MessagelistUserStore.pageBeforeThread(MessagelistUserStore.page());

			hasher.setHash(
				mailBox(FolderUserStore.currentFolderFullNameHash(), 1, MessagelistUserStore.listSearch(), message.uid)
			);
		}
	}

	listEmptyMessage() {
		if (!this.dragOver()
		 && !MessagelistUserStore().length
		 && !MessagelistUserStore.isLoading()
		 && !MessagelistUserStore.error()) {
			 return i18n('MESSAGE_LIST/EMPTY_' + (MessagelistUserStore.listSearch() ? 'SEARCH_' : '') + 'LIST');
		}
		return '';
	}

	onBuild(dom) {
		const b_content = dom.querySelector('.b-content'),
			eqs = (ev, s) => ev.target.closestWithin(s, dom);

		setTimeout(() => {
			// initMailboxLayoutResizer
			const top = dom.querySelector('.messageList'),
				fToggle = () => {
					let layout = SettingsUserStore.usePreviewPane();
					setLayoutResizer(top, ClientSideKeyNameMessageListSize,
						layout ? (LayoutSideView === layout ? 'Width' : 'Height') : 0
					);
				};
			if (top) {
				fToggle();
				addEventListener('rl-layout', fToggle);
			}
		}, 1);

		this.selector.init(b_content, ScopeMessageList);

		let gesture,
			suppressClickUntil = 0;
		const
			interactiveSelector = 'a,button,input,select,textarea,[contenteditable],[role="button"],'
				+ '.messageCheckbox,.flagParent,.threads-len',
			unlockSwipeScroll = () => b_content.classList.remove('swipe-locked'),
			resetSwipeRow = row => {
				if (!row) {
					return;
				}
				row.classList.remove('swipe-active');
				row.style.removeProperty('--message-swipe-x');
				row.style.removeProperty('--message-swipe-height');
				row.style.removeProperty('--message-swipe-width');
				delete row.dataset.swipeAction;
				delete row.dataset.swipeDirection;
			},
			cancelGesture = reset => {
				if (!gesture) {
					return;
				}
				clearTimeout(gesture.longPressTimer);
				const { pointerId, row } = gesture;
				row.hasPointerCapture?.(pointerId) && row.releasePointerCapture(pointerId);
				unlockSwipeScroll();
				reset && resetSwipeRow(row);
				gesture = null;
			},
			keepSwipeScrollLocked = event => {
				if (gesture?.horizontal) {
					event?.cancelable && event.preventDefault();
					b_content.scrollTop !== gesture.scrollTop
						&& (b_content.scrollTop = gesture.scrollTop);
				}
			},
			previewAction = (row, distance, width) => {
				if (distance) {
					row.dataset.swipeDirection = 0 < distance ? 'right' : 'left';
				} else {
					delete row.dataset.swipeDirection;
				}
				let action = classifyMessageSwipe(distance, width);
				if ('spam' === action && !this.canMarkAsSpam()) {
					action = 'delete';
				}
				if (!action) {
					delete row.dataset.swipeAction;
					return;
				}
				row.dataset.swipeAction = action;
			},
			commitGesture = (action, message, row) => {
				resetSwipeRow(row);
				if ('archive' === action) {
					this.archiveMessage(message, row);
				} else if ('delete' === action) {
					this.deleteMessage(message, row);
				} else if ('spam' === action) {
					this.spamMessage(message, row);
				} else if ('snooze' === action) {
					this.snoozeMessage(message);
				}
			},
			pointerDown = event => {
				if (!ThemeStore.isMobile() || false === event.isPrimary || event.button
					|| MessagelistUserStore.hasChecked() || MessagelistUserStore.mutationLoading()
					|| event.target.closest(interactiveSelector)) {
					return;
				}
				const row = event.target.closestWithin('.messageListItem', b_content);
				if (!row) {
					return;
				}
				cancelGesture(true);
				const
					message = ko.dataFor(row),
					bounds = row.getBoundingClientRect();
				gesture = {
					distance: 0,
					direction: 0,
					height: bounds.height,
					horizontal: false,
					message: message,
					pointerId: event.pointerId,
					row: row,
					width: bounds.width,
					x: event.clientX,
					y: event.clientY
				};
				gesture.longPressTimer = setTimeout(() => {
					if (gesture?.row === row && !gesture.horizontal) {
						message?.checked(true);
						navigator.vibrate?.(10);
						suppressClickUntil = Date.now() + 600;
						cancelGesture(true);
					}
				}, 550);
			},
			pointerMove = event => {
				if (!gesture || gesture.pointerId !== event.pointerId) {
					return;
				}
				const
					distance = event.clientX - gesture.x,
					vertical = event.clientY - gesture.y,
					horizontalDistance = Math.abs(distance),
					verticalDistance = Math.abs(vertical);
				if (8 < Math.max(horizontalDistance, verticalDistance)) {
					clearTimeout(gesture.longPressTimer);
					gesture.longPressTimer = 0;
				}
				if (!gesture.horizontal) {
					const intent = classifyMessageSwipeIntent(horizontalDistance, verticalDistance);
					if ('vertical' === intent) {
						cancelGesture(true);
						return;
					}
					if ('horizontal' !== intent) {
						return;
					}
					gesture.horizontal = true;
					gesture.direction = 0 < distance ? 1 : -1;
					gesture.scrollTop = b_content.scrollTop;
					clearTimeout(gesture.longPressTimer);
					gesture.row.style.setProperty('--message-swipe-height', gesture.height + 'px');
					gesture.row.style.setProperty('--message-swipe-width', gesture.width + 'px');
					gesture.row.classList.add('swipe-active');
					b_content.classList.add('swipe-locked');
					gesture.row.setPointerCapture?.(gesture.pointerId);
				}
				const directionalDistance = Math.max(0, distance * gesture.direction);
				gesture.distance = gesture.direction * Math.min(gesture.width * 0.72, directionalDistance);
				gesture.row.style.setProperty('--message-swipe-x',
					projectMessageSwipe(gesture.distance, gesture.direction) + 'px');
				previewAction(gesture.row, gesture.distance, gesture.width);
				keepSwipeScrollLocked(event);
			},
			pointerUp = event => {
				if (!gesture || gesture.pointerId !== event.pointerId) {
					return;
				}
				const current = gesture;
				clearTimeout(current.longPressTimer);
				gesture = null;
				unlockSwipeScroll();
				current.row.hasPointerCapture?.(current.pointerId)
					&& current.row.releasePointerCapture(current.pointerId);
				if (!current.horizontal) {
					return;
				}
				suppressClickUntil = Date.now() + 600;
				current.row.classList.remove('swipe-active');
				let action = classifyMessageSwipe(current.distance, current.width);
				if ('spam' === action && !this.canMarkAsSpam()) {
					action = 'delete';
				}
				action ? commitGesture(action, current.message, current.row) : resetSwipeRow(current.row);
			};

		b_content.addEventListener('pointerdown', pointerDown, {passive: true});
		b_content.addEventListener('pointermove', pointerMove, {passive: false});
		b_content.addEventListener('pointerup', pointerUp, {passive: true});
		b_content.addEventListener('pointercancel', () => cancelGesture(true), {passive: true});
		b_content.addEventListener('touchmove', keepSwipeScrollLocked, {passive: false});
		b_content.addEventListener('scroll', keepSwipeScrollLocked, {passive: true});
		b_content.addEventListener('click', event => {
			if (Date.now() < suppressClickUntil) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		}, true);

		addEventsListeners(dom, {
			click: event => {
				if (eqs(event, '.toggleLeft')) {
					toggleLeftPanel();
				} else {
					ThemeStore.isMobile() && leftPanelDisabled(true);

					if (eqs(event, '.messageList') && ScopeMessageView === AppUserStore.focusedState()) {
						AppUserStore.focusedState(ScopeMessageList);
					}

					let el = eqs(event, '.e-paginator a');
					el && this.gotoPage(ko.dataFor(el)?.value);

					eqs(event, '.checkboxCheckAll') && this.checkAll(!this.checkAll());
				}
			},
			keydown: event => {
				const checkbox = eqs(event, '.messageCheckbox');
				if (checkbox && (' ' === event.key || 'Enter' === event.key)) {
					stopEvent(event);
					const message = ko.dataFor(checkbox);
					message?.checked(!message.checked());
					return;
				}
				const thread = eqs(event, '.threads-len');
				if (thread && (' ' === event.key || 'Enter' === event.key)) {
					stopEvent(event);
					this.gotoThread(ko.dataFor(thread));
				}
			},
			dblclick: event => {
				let msg = ko.dataFor(eqs(event, '.messageListItem'));
				if (msg) {
					msg.threadsLen() ? this.gotoThread(msg) : toggleFullscreen();
				}
			}
		});

		// initUploaderForAppend

		if (Settings.app('allowAppendMessage')) {
			const dropZone = dom.querySelector('.listDragOver'),
				validFiles = oEvent => {
					for (const item of oEvent.dataTransfer.items) {
						if ('file' === item.kind && RFC822 === item.type) {
							return true;
						}
					}
				};
			addEventsListeners(dropZone, {
				dragover: oEvent => {
					if (validFiles(oEvent)) {
						oEvent.dataTransfer.dropEffect = 'copy';
						oEvent.preventDefault();
					}
				},
			});
			addEventsListeners(b_content, {
				dragenter: oEvent => {
					if (validFiles(oEvent)) {
						if (b_content.contains(oEvent.target)) {
							this.dragOver(true);
						}
						if (oEvent.target == dropZone) {
							oEvent.dataTransfer.dropEffect = 'copy';
							this.dragOverEnter(true);
						}
					}
				},
				dragleave: oEvent => {
					if (oEvent.target == dropZone) {
						this.dragOverEnter(false);
					}
					let related = oEvent.relatedTarget;
					if (!related || !b_content.contains(related)) {
						this.dragOver(false);
					}
				},
				drop: oEvent => {
					oEvent.preventDefault();
					if (oEvent.target == dropZone && validFiles(oEvent)) {
						MessagelistUserStore.loading(true);
						dropFilesInFolder(FolderUserStore.currentFolderFullName(), oEvent.dataTransfer.files);
					}
					this.dragOverEnter(false);
					this.dragOver(false);
				}
			});
		}

		// initShortcuts

		addShortcut('enter,open', '', ScopeMessageList, () => {
			if (formFieldFocused()) {
				MessagelistUserStore.mainSearch(sLastSearchValue);
				return false;
			}
			if (MessageUserStore.message() && MessagelistUserStore.canSelect()) {
				isFullscreen() || toggleFullscreen();
				return false;
			}
		});

		// archive (zip)
		registerShortcut('z', '', [ScopeMessageList, ScopeMessageView], () => {
			this.archiveCommand();
			return false;
		});

		// delete
		registerShortcut('delete', 'shift', ScopeMessageList, () => {
			MessagelistUserStore.listCheckedOrSelected().length && this.deleteWithoutMoveCommand();
			return false;
		});
//		registerShortcut('3', 'shift', ScopeMessageList, () => {
		registerShortcut('delete', '', ScopeMessageList, () => {
			MessagelistUserStore.listCheckedOrSelected().length && this.deleteCommand();
			return false;
		});

		// check mail
		addShortcut('r', 'meta', [ScopeFolderList, ScopeMessageList, ScopeMessageView], () => {
			this.reload();
			return false;
		});

		// check all
		registerShortcut('a', 'meta', ScopeMessageList, () => {
			this.checkAll(!(this.checkAll() && !this.isIncompleteChecked()));
			return false;
		});

		// write/compose (open compose popup)
		registerShortcut('w,c,new', '', [ScopeMessageList, ScopeMessageView], () => {
			showMessageComposer();
			return false;
		});

		// important - star/flag messages
		registerShortcut('i', '', [ScopeMessageList, ScopeMessageView], () => {
			const checked = MessagelistUserStore.listCheckedOrSelected();
			if (checked.length) {
				listAction(
					checked[0].folder,
					checked.every(message => message.isFlagged()) ? MessageSetAction.UnsetFlag : MessageSetAction.SetFlag,
					checked
				);
			}
			return false;
		});

		registerShortcut('t', '', [ScopeMessageList], () => {
			let message = MessagelistUserStore.selectedMessage() || MessagelistUserStore.focusedMessage();
			if (0 < message?.threadsLen()) {
				this.gotoThread(message);
			}
			return false;
		});

		// move
		registerShortcut('insert', '', ScopeMessageList, () => {
			this.moveCommand();
			return false;
		});

		// read
		registerShortcut('q', '', [ScopeMessageList, ScopeMessageView], () => {
			this.seenMessagesFast(true);
			return false;
		});

		// unread
		registerShortcut('u', '', [ScopeMessageList, ScopeMessageView], () => {
			this.seenMessagesFast(false);
			return false;
		});

		registerShortcut('f,mailforward', 'shift', [ScopeMessageList, ScopeMessageView], () => {
			this.forwardCommand();
			return false;
		});

		if (SettingsCapa('Search')) {
			// search input focus
			addShortcut('/', '', [ScopeMessageList, ScopeMessageView], () => {
				this.focusSearch(true);
				return false;
			});
		}

		// cancel search
		addShortcut('escape', '', ScopeMessageList, () => {
			if (this.messageListSearchDesc()) {
				this.cancelSearch();
				return false;
			} else if (MessagelistUserStore.endThreadUid()) {
				this.cancelThreadUid();
				return false;
			}
		});

		// change focused state
		addShortcut('tab', 'shift', ScopeMessageList, () => {
			AppUserStore.focusedState(ScopeFolderList);
			return false;
		});
		addShortcut('arrowleft', '', ScopeMessageList, () => {
			AppUserStore.focusedState(ScopeFolderList);
			return false;
		});
		addShortcut('tab,arrowright', '', ScopeMessageList, () => {
			if (MessageUserStore.message()) {
				AppUserStore.focusedState(ScopeMessageView);
				return false;
			}
		});

		addShortcut('arrowleft', 'meta', ScopeMessageView, ()=>false);
		addShortcut('arrowright', 'meta', ScopeMessageView, ()=>false);

		addShortcut('f', 'meta', ScopeMessageList, this.advancedSearchClick);
	}

	advancedSearchClick() {
		showScreenPopup(AdvancedSearchPopupView, [MessagelistUserStore.mainSearch()]);
	}

	showMessageReceipts(message, event) {
		stopEvent(event);
		const messageId = message?.messageId?.replace(/([\\"])/g, '\\$1');
		messageId && hasher.setHash(mailBox(
			getFolderInboxName(),
			1,
			`header:"Content-Type multipart/report" body:"${messageId}"`
		));
	}

	groupSearch(group) {
		group.search && MessagelistUserStore.mainSearch(group.search);
	}

	groupCheck(group) {
		group.messages.forEach(message => message.checked(!message.checked()));
	}

	quotaTooltip() {
		return i18n('MESSAGE_LIST/QUOTA_SIZE', {
			SIZE: FileInfo.friendlySize(FolderUserStore.quotaUsage()),
			PROC: FolderUserStore.quotaPercentage(),
			LIMIT: FileInfo.friendlySize(FolderUserStore.quotaLimit())
		}).replace(/<[^>]+>/g, '');
	}
}
