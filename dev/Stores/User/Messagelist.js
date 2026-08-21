import { koComputable, addObservablesTo, addComputablesTo } from 'External/ko';

import { SMAudio } from 'Common/Audio';
import { Notifications } from 'Common/Enums';
import { MessageSetAction } from 'Common/EnumsUser';
import { $htmlCL, fireEvent } from 'Common/Globals';
import { arrayLength, pString } from 'Common/Utils';
import { UNUSED_OPTION_VALUE } from 'Common/Consts';

import {
	getFolderInboxName,
	getFolderFromCacheList,
	setFolderETag
} from 'Common/Cache';

import { mailBox } from 'Common/Links';
import { i18n, getNotification } from 'Common/Translator';

import { EmailCollectionModel } from 'Model/EmailCollection';
import { MessageCollectionModel } from 'Model/MessageCollection';

import { AccountUserStore } from 'Stores/User/Account';
import { FolderUserStore } from 'Stores/User/Folder';
import { MessageUserStore } from 'Stores/User/Message';
import { NotificationUserStore } from 'Stores/User/Notification';
import { SettingsUserStore } from 'Stores/User/Settings';

import Remote from 'Remote/User/Fetch';

import { b64EncodeJSONSafe } from 'Common/Utils';
import { SettingsGet } from 'Common/Globals';
import { SUB_QUERY_PREFIX } from 'Common/Links';
import { AppUserStore } from 'Stores/User/App';

import { classifyMessagePage } from 'Classifier/EmailClassifier';

import { baseCollator } from 'Common/Translator';

const
	isChecked = item => item.checked(),
	isDeleted = item => item.isDeleted(),
	replaceHash = hash => {
		rl.route.off();
		hasher.replaceHash(hash);
		rl.route.on();
	},
	disableAutoSelect = ko.observable(false).extend({ falseTimeout: 500 });

let categoryRouteReloadTimer = 0;
const categoryRouteFolders = new Set;

export const MessagelistUserStore = ko.observableArray().extend({ debounce: 0 });

addObservablesTo(MessagelistUserStore, {
	count: 0,
	listSearch: '',
	listLimited: 0,
	threadUid: 0,
	page: 1,
	pageBeforeThread: 1,
	error: '',
//	folder: '',

	endHash: '',
	endThreadUid: 0,

	loading: false,
	// Happens when message(s) removed from list
	isIncomplete: false,
	mutationLoading: false,

	selectedMessage: null,
	focusedMessage: null,

	allSelected: false,
	allSelectionLoading: false,
	allSelectionError: '',
	allSelectionCount: 0,
	allSelectionViewCount: 0,
	allSelectionUids: null
});

MessagelistUserStore.clearAllSelection = (clearMessages = false) => {
	MessagelistUserStore.allSelectionLoading() && Remote.abort('MessageListUids');
	MessagelistUserStore.allSelected(false);
	MessagelistUserStore.allSelectionLoading(false);
	MessagelistUserStore.allSelectionError('');
	MessagelistUserStore.allSelectionCount(0);
	MessagelistUserStore.allSelectionViewCount(0);
	MessagelistUserStore.allSelectionUids(null);

	clearMessages && MessagelistUserStore.forEach(message => message.checked(false));
};

// Computed Observables

addComputablesTo(MessagelistUserStore, {
	isLoading: () => {
		const value = MessagelistUserStore.loading()
			|| MessagelistUserStore.isIncomplete()
			|| MessagelistUserStore.mutationLoading();
		$htmlCL.toggle('list-loading', value);
		return value;
	},

	isArchiveFolder: () => FolderUserStore.archiveFolder() === MessagelistUserStore().folder,

	isDraftFolder: () => FolderUserStore.draftsFolder() === MessagelistUserStore().folder,

	isSentFolder: () => FolderUserStore.sentFolder() === MessagelistUserStore().folder,

	isSpamFolder: () => FolderUserStore.spamFolder() === MessagelistUserStore().folder,

	isTrashFolder: () => FolderUserStore.trashFolder() === MessagelistUserStore().folder,

	archiveAllowed: () => ![UNUSED_OPTION_VALUE, MessagelistUserStore().folder].includes(FolderUserStore.archiveFolder())
		&& !MessagelistUserStore.isDraftFolder(),

	canMarkAsSpam: () => !(UNUSED_OPTION_VALUE === FolderUserStore.spamFolder()
//		| MessagelistUserStore.isArchiveFolder()
		| MessagelistUserStore.isSentFolder()
		| MessagelistUserStore.isDraftFolder()
		| MessagelistUserStore.isSpamFolder()),

	pageCount: () => Math.max(1, Math.ceil(MessagelistUserStore.count() / SettingsUserStore.messagesPerPage())),

	mainSearch: {
		read: MessagelistUserStore.listSearch,
		write: value => hasher.setHash(
			mailBox(FolderUserStore.currentFolderFullNameHash(), 1,
				value.toString().trim(), MessagelistUserStore.threadUid())
		)
	},

	listCheckedOrSelected: () => {
		const
			selectedMessage = MessagelistUserStore.selectedMessage(),
			checked = MessagelistUserStore.filter(item => isChecked(item));
		return checked.length ? checked : (selectedMessage ? [selectedMessage] : []);
	},

	selectedCount: () =>
		MessagelistUserStore.allSelected()
			? MessagelistUserStore.allSelectionViewCount()
			: MessagelistUserStore.listCheckedOrSelected().length,

	listCheckedOrSelectedUidsWithSubMails: () => {
		let result = new Set;
		if (MessagelistUserStore.allSelected()) {
			(MessagelistUserStore.allSelectionUids() || []).forEach(result.add, result);
			result.folder = FolderUserStore.currentFolderFullName();
			result.allSelected = true;
			result.viewCount = MessagelistUserStore.allSelectionViewCount();
		} else {
			MessagelistUserStore.listCheckedOrSelected().forEach(message => {
				result.add(message.uid);
				result.folder = message.folder;
				if (1 < message.threadsLen()) {
					message.threads().forEach(result.add, result);
				}
			});
		}
		return result;
	}
});

MessagelistUserStore.listChecked = koComputable(
	() => MessagelistUserStore.filter(isChecked)
).extend({ rateLimit: 0 });

// Also used by Selector
MessagelistUserStore.hasChecked = koComputable(
	// Issue: not all are observed?
	() => MessagelistUserStore.allSelected() || !!MessagelistUserStore.find(isChecked)
).extend({ rateLimit: 0 });

MessagelistUserStore.hasCheckedOrSelected = koComputable(() =>
	MessagelistUserStore.allSelected()
	|| !!MessagelistUserStore.selectedMessage()
	// Issue: not all are observed?
	|| !!MessagelistUserStore.find(isChecked)
).extend({ rateLimit: 50 });

MessagelistUserStore.hasCheckedOrSelectedAndDeleted = koComputable(
	() => !MessagelistUserStore.allSelected() && !!MessagelistUserStore.listCheckedOrSelected().find(isDeleted)
).extend({ rateLimit: 50 });

MessagelistUserStore.hasCheckedOrSelectedAndUndeleted = koComputable(
	() => MessagelistUserStore.allSelected()
		|| !!MessagelistUserStore.listCheckedOrSelected().find(item => !item?.isDeleted())
).extend({ rateLimit: 50 });

MessagelistUserStore.listChecked.subscribe(items => {
	if (MessagelistUserStore.allSelected() && items.length < MessagelistUserStore().length) {
		MessagelistUserStore.clearAllSelection();
	}
});

MessagelistUserStore.notifyNewMessages = (folder, newMessages) => {
	if (getFolderInboxName() === folder && arrayLength(newMessages)) {

		SMAudio.playNotification();

		const len = newMessages.length;
		if (3 < len) {
			NotificationUserStore.display(
				AccountUserStore.email(),
				i18n('MESSAGE_LIST/NEW_MESSAGE_NOTIFICATION', {
					COUNT: len
				}),
				{ Url: mailBox(newMessages[0].folder) }
			);
		} else {
			newMessages.forEach(item => {
				NotificationUserStore.display(
					EmailCollectionModel.reviveFromJson(item.from).toString(),
					item.subject,
					{ folder: item.folder, uid: item.uid }
				);
			});
		}
	}
}

MessagelistUserStore.canSelect = () =>
	!disableAutoSelect()
	&& SettingsUserStore.usePreviewPane();
//	&& !SettingsUserStore.showNextMessage();

let prevFolderName;

/**
 * @param {boolean=} bDropPagePosition = false
 * @param {boolean=} bDropCurrentFolderCache = false
 */
MessagelistUserStore.reload = (bDropPagePosition = false, bDropCurrentFolderCache = false) => {
	let iOffset = (MessagelistUserStore.page() - 1) * SettingsUserStore.messagesPerPage(),
		folderName = FolderUserStore.currentFolderFullName();
//		folderName = FolderUserStore.currentFolder() ? self.currentFolder().fullName : '');

	MessagelistUserStore.clearAllSelection();

	if (bDropCurrentFolderCache) {
		setFolderETag(folderName, '');
	}

	if (bDropPagePosition) {
		MessagelistUserStore.page(1);
		MessagelistUserStore.pageBeforeThread(1);
		iOffset = 0;

		replaceHash(
			mailBox(
				FolderUserStore.currentFolderFullNameHash(),
				MessagelistUserStore.page(),
				MessagelistUserStore.listSearch(),
				MessagelistUserStore.threadUid()
			)
		);
	}

	if (prevFolderName != folderName) {
		prevFolderName = folderName;
		MessagelistUserStore([]);
	}

	MessagelistUserStore.loading(true);

	let sGetAdd = '',
//		folder = getFolderFromCacheList(folderName.fullName),
		folder = getFolderFromCacheList(folderName),
		folderETag = folder?.etag || '',
		params = {
			folder: folderName,
			offset: iOffset,
			limit: SettingsUserStore.messagesPerPage(),
			uidNext: folder?.uidNext || 0, // Used to check for new messages
			sort: FolderUserStore.sortMode(),
			search: MessagelistUserStore.listSearch()
		},
		fCallback = (iError, oData, bCached) => {
			let error = '';
			if (iError) {
				if ('reload' != oData?.name) {
					error = getNotification(iError);
					MessagelistUserStore.loading(false);
//					if (Notifications.RequestAborted !== iError) {
//						MessagelistUserStore([]);
//					}
//					if (oData.message) { error = oData.message + error; }
				}
			} else {
				const collection = MessageCollectionModel.reviveFromJson(oData.Result, bCached);
				if (collection) {
					const
						folderInfo = collection.folder,
						folder = getFolderFromCacheList(folderInfo.name);
					collection.folder = folderInfo.name;
					if (folder && !bCached) {
//						folder.revivePropertiesFromJson(result);
						folder.expires = Date.now();
						folder.uidNext = folderInfo.uidNext;
						folder.etag = folderInfo.etag;

						if (null != folderInfo.totalEmails) {
							folder.totalEmails(folderInfo.totalEmails);
						}

						if (null != folderInfo.unreadEmails) {
							folder.unreadEmails(folderInfo.unreadEmails);
						}

						let flags = folderInfo.permanentFlags || [];
						if (flags.includes('\\*')) {
							/** Add Thunderbird labels */
							let i = 6;
							while (--i) {
								flags.includes('$label'+i) || flags.push('$label'+i);
							}
							/** TODO: add others by default? */
						}
						folder.permanentFlags(flags.sort(baseCollator().compare));

						MessagelistUserStore.notifyNewMessages(folder.fullName, collection.newMessages);
					}

					MessagelistUserStore.count(collection.totalEmails);
					MessagelistUserStore.listSearch(pString(collection.search));
					MessagelistUserStore.listLimited(!!collection.limited);
					MessagelistUserStore.page(Math.ceil(collection.offset / SettingsUserStore.messagesPerPage() + 1));
					MessagelistUserStore.threadUid(collection.threadUid);

					MessagelistUserStore.endHash(
						folderInfo.name +
						'|' + collection.search +
						'|' + MessagelistUserStore.threadUid() +
						'|' + MessagelistUserStore.page()
					);
					MessagelistUserStore.endThreadUid(collection.threadUid);
					const message = MessageUserStore.message();
					if (message && folderInfo.name !== message.folder) {
						MessageUserStore.message(null);
					}

					disableAutoSelect(true);

					if (collection.threadUid) {
						let refs = {};
						collection.forEach(msg => {
							msg.level = 0;
							if (msg.inReplyTo && refs[msg.inReplyTo]) {
								msg.level = 1 + refs[msg.inReplyTo].level;
							}
							refs[msg.messageId] = msg;
						});
					}

					MessagelistUserStore(collection);
					classifyMessagePage(collection);
					MessagelistUserStore.isIncomplete(false);
				} else {
					MessagelistUserStore.count(0);
					MessagelistUserStore([]);
					error = getNotification(Notifications.CantGetMessageList);
				}
				MessagelistUserStore.loading(false);
			}
			MessagelistUserStore.error(error);
		};

	if (AppUserStore.threadsAllowed() && SettingsUserStore.useThreads()) {
		params.useThreads = 1;
		params.threadAlgorithm = SettingsUserStore.threadAlgorithm();
		params.threadUid = MessagelistUserStore.threadUid();
	} else {
		params.threadUid = 0;
	}
	if (folderETag) {
		params.hash = folderETag + '-' + SettingsGet('accountHash');
		sGetAdd = 'MessageList/' + SUB_QUERY_PREFIX + '/' + b64EncodeJSONSafe(params);
		params = {};
	}

	Remote.abort('MessageList', 'reload').request('MessageList',
		fCallback,
		params,
		10000,
		sGetAdd
	);
};

addEventListener('mailbox.message.category-routed', event => {
	const { fromFolder, message, toFolder } = event.detail || {},
		opened = MessageUserStore.message();
	setFolderETag(fromFolder, '');
	setFolderETag(toFolder, '');
	categoryRouteFolders.add(fromFolder).add(toFolder);
	if (opened && opened.folder === fromFolder && opened.uid === message?.uid) {
		MessageUserStore.message(null);
		MessagelistUserStore.selectedMessage(null);
	}
	clearTimeout(categoryRouteReloadTimer);
	categoryRouteReloadTimer = setTimeout(() => {
		categoryRouteFolders.has(FolderUserStore.currentFolderFullName())
			&& MessagelistUserStore.reload(false, true);
		categoryRouteFolders.clear();
	}, 150);
});

MessagelistUserStore.selectAllInView = () => {
	const folderName = FolderUserStore.currentFolderFullName();
	if (!folderName || MessagelistUserStore.allSelected() || MessagelistUserStore.allSelectionLoading()) {
		return;
	}

	MessagelistUserStore.allSelectionLoading(true);
	MessagelistUserStore.allSelectionError('');

	const params = {
		folder: folderName,
		sort: FolderUserStore.sortMode(),
		search: MessagelistUserStore.listSearch()
	};

	if (AppUserStore.threadsAllowed() && SettingsUserStore.useThreads()) {
		params.useThreads = 1;
		params.threadAlgorithm = SettingsUserStore.threadAlgorithm();
		params.threadUid = MessagelistUserStore.threadUid();
	} else {
		params.threadUid = 0;
	}

	Remote.abort('MessageListUids').request('MessageListUids', (iError, data) => {
		MessagelistUserStore.allSelectionLoading(false);

		if (iError) {
			MessagelistUserStore.allSelectionError(getNotification(iError));
			return;
		}

		const
			result = data?.Result || {},
			uids = (result.uids || [])
				.map(uid => parseInt(uid, 10))
				.validUnique();

		MessagelistUserStore.allSelectionUids(uids);
		MessagelistUserStore.allSelectionCount(uids.length);
		MessagelistUserStore.allSelectionViewCount(Math.max(0, parseInt(result.count, 10) || uids.length));
		MessagelistUserStore.allSelected(!!uids.length);

		if (uids.length) {
			const selectedUids = new Set(uids);
			MessagelistUserStore.forEach(message => message.checked(selectedUids.has(message.uid)));
		}
	}, params, 10000);
};

MessagelistUserStore.setAllSeen = (folderName, threadUids = []) => {
	const folder = getFolderFromCacheList(folderName);
	if (!folder || MessagelistUserStore.mutationLoading()) {
		return;
	}

	MessagelistUserStore.mutationLoading(true);
	Remote.request('MessageSetSeenToAll', error => {
		MessagelistUserStore.mutationLoading(false);
		if (error) {
			setFolderETag(folderName, '');
			MessagelistUserStore.reload(false, true);
			alert(getNotification(error));
			return;
		}

		if (!threadUids.length) {
			folder.unreadEmails(0);
		}
		MessagelistUserStore.clearAllSelection(true);
		MessagelistUserStore.reload(false, true);
	}, {
		folder: folderName,
		setAction: 1,
		threadUids: threadUids.join(',')
	});
};

/**
 * @param {string} sFolderFullName
 * @param {number} iSetAction
 * @param {Array=} messages = null
 */
MessagelistUserStore.setAction = (sFolderFullName, iSetAction, messages) => {
	if (MessagelistUserStore.mutationLoading()) {
		return;
	}
	const
		allSelected = MessagelistUserStore.allSelected(),
		allSelectionUids = allSelected ? (MessagelistUserStore.allSelectionUids() || []) : null,
		allSelectionUidSet = allSelectionUids ? new Set(allSelectionUids) : null;

	if (allSelected
		&& MessageSetAction.SetSeen === iSetAction
		&& !MessagelistUserStore.listSearch()
		&& !MessagelistUserStore.threadUid()
	) {
		MessagelistUserStore.setAllSeen(sFolderFullName);
		return;
	}

	const
		complete = iError => {
			if (iError) {
				setFolderETag(sFolderFullName, '');
				MessagelistUserStore.isIncomplete(false);
				MessagelistUserStore.reload(false, true);
				alert(getNotification(iError));
			} else if (allSelected) {
				MessagelistUserStore.clearAllSelection();
				MessagelistUserStore.reload(false, true);
			}
			MessagelistUserStore.mutationLoading(false);
		};

	messages = allSelected
		? MessagelistUserStore.filter(message => allSelectionUidSet.has(message.uid))
		: (messages || MessagelistUserStore.listChecked());

	let folder,
		rootUids = allSelectionUids ? allSelectionUids.slice() : [],
		length,
		unreadDelta = 0;

	const conversationUids = message => {
		const uids = [message.uid, ...message.threads()].validUnique();
		allSelected || rootUids.push(...uids);
		return uids;
	};

	if (iSetAction == MessageSetAction.SetSeen) {
		messages.forEach(oMessage => {
			const unseen = new Set(oMessage.threadUnseen());
			oMessage.isUnseen() && unseen.add(oMessage.uid);
			if (unseen.size) {
				conversationUids(oMessage);
				unreadDelta -= unseen.size;
				oMessage.isUnseen() && oMessage.flags.push('\\seen');
				oMessage.threadUnseen.removeAll();
			}
		});
	} else if (iSetAction == MessageSetAction.UnsetSeen) {
		messages.forEach(oMessage => {
			const uids = conversationUids(oMessage),
				unseen = new Set(oMessage.threadUnseen());
			oMessage.isUnseen() && unseen.add(oMessage.uid);
			if (unseen.size < uids.length) {
				unreadDelta += uids.length - unseen.size;
				oMessage.flags.remove('\\seen');
				oMessage.threadUnseen(uids);
			}
		});
	} else if (iSetAction == MessageSetAction.SetFlag) {
		messages.forEach(oMessage => {
			conversationUids(oMessage);
			oMessage.isFlagged() || oMessage.flags.push('\\flagged');
		});
	} else if (iSetAction == MessageSetAction.UnsetFlag) {
		messages.forEach(oMessage => {
			conversationUids(oMessage);
			oMessage.flags.remove('\\flagged');
		});
	} else if (iSetAction == MessageSetAction.SetDeleted) {
		messages.forEach(oMessage => {
			conversationUids(oMessage);
			oMessage.isDeleted() || oMessage.flags.push('\\deleted');
		});
	} else if (iSetAction == MessageSetAction.UnsetDeleted) {
		messages.forEach(oMessage => {
			conversationUids(oMessage);
			oMessage.flags.remove('\\deleted');
		});
	}
	rootUids = rootUids.validUnique();
	length = rootUids.length;

	if (sFolderFullName && length) {
		MessagelistUserStore.mutationLoading(true);
		switch (iSetAction) {
		case MessageSetAction.SetSeen:
				// fallthrough is intentionally
			case MessageSetAction.UnsetSeen:
				folder = getFolderFromCacheList(sFolderFullName);
				if (folder && !allSelected) {
					folder.unreadEmails(Math.max(0, folder.unreadEmails() + unreadDelta));
				}
				Remote.request('MessageSetSeen', complete, {
					folder: sFolderFullName,
					uids: rootUids.join(','),
					setAction: iSetAction == MessageSetAction.SetSeen ? 1 : 0
				});
				break;

			case MessageSetAction.SetFlag:
			case MessageSetAction.UnsetFlag:
				Remote.request('MessageSetFlagged', complete, {
					folder: sFolderFullName,
					uids: rootUids.join(','),
					setAction: iSetAction == MessageSetAction.SetFlag ? 1 : 0
				});
				break;

			case MessageSetAction.SetDeleted:
			case MessageSetAction.UnsetDeleted:
				Remote.request('MessageSetDeleted', complete, {
					folder: sFolderFullName,
					uids: rootUids.join(','),
					setAction: iSetAction == MessageSetAction.SetDeleted ? 1 : 0
				});
				break;
			default:
				MessagelistUserStore.mutationLoading(false);
				break;
		}
	}
};

/**
 * @param {string} fromFolderFullName
 * @param {Set} oUids
 * @param {string=} toFolderFullName = ''
 * @param {boolean=} copy = false
 */
MessagelistUserStore.moveMessages = (
	fromFolderFullName, oUids, toFolderFullName = '', copy = false
) => {
	const fromFolder = getFolderFromCacheList(fromFolderFullName);

	if (!fromFolder || !oUids?.size || MessagelistUserStore.mutationLoading()) return;

	let unseenCount = 0,
		setPage = 0,
		currentMessage = MessageUserStore.message();

	const toFolder = toFolderFullName ? getFolderFromCacheList(toFolderFullName) : null,
		allSelected = !!oUids.allSelected,
		listRemoveCount = allSelected ? (oUids.viewCount || MessagelistUserStore.count()) : oUids.size,
		trashFolder = FolderUserStore.trashFolder(),
		spamFolder = FolderUserStore.spamFolder(),
		page = MessagelistUserStore.page(),
		messages =
			FolderUserStore.currentFolderFullName() === fromFolderFullName
				? MessagelistUserStore.filter(item => item && oUids.has(item.uid))
				: [],
		moveOrDeleteResponseHelper = (iError, oData) => {
			if (iError) {
				setFolderETag(FolderUserStore.currentFolderFullName(), '');
				MessagelistUserStore.isIncomplete(false);
				MessagelistUserStore.reload(false, true);
				alert(getNotification(iError));
			} else if (FolderUserStore.currentFolder()) {
				if (2 === arrayLength(oData.Result)) {
					setFolderETag(oData.Result[0], oData.Result[1]);
				} else {
					setFolderETag(FolderUserStore.currentFolderFullName(), '');
				}

				allSelected && MessagelistUserStore.clearAllSelection();
				MessagelistUserStore.count(MessagelistUserStore.count() - listRemoveCount);
				if (page > MessagelistUserStore.pageCount()) {
					setPage = MessagelistUserStore.pageCount();
				}
				if (setPage) {
					MessagelistUserStore.page(setPage);
					replaceHash(
						mailBox(
							FolderUserStore.currentFolderFullNameHash(),
							setPage,
							MessagelistUserStore.listSearch(),
							MessagelistUserStore.threadUid()
						)
					);
				}

				MessagelistUserStore.reload(!MessagelistUserStore.count());
			}
			MessagelistUserStore.mutationLoading(false);
		},
		copyResponseHelper = iError => {
			if (iError) {
				setFolderETag(FolderUserStore.currentFolderFullName(), '');
				MessagelistUserStore.reload(false, true);
				alert(getNotification(iError));
			} else if (allSelected) {
				MessagelistUserStore.clearAllSelection(true);
			}
			MessagelistUserStore.mutationLoading(false);
		};

	if (toFolderFullName && (!toFolder || fromFolderFullName === toFolderFullName)) {
		return;
	}
	MessagelistUserStore.mutationLoading(true);

	messages.forEach(item => item?.isUnseen() && ++unseenCount);

	if (!copy) {
		fromFolder.etag = '';
		fromFolder.totalEmails(Math.max(0, fromFolder.totalEmails() - oUids.size));
		fromFolder.unreadEmails(Math.max(0, fromFolder.unreadEmails() - unseenCount));
	}

	if (toFolder) {
		toFolder.etag = '';
		toFolder.totalEmails(toFolder.totalEmails() + oUids.size);
		if (trashFolder !== toFolder.fullName && spamFolder !== toFolder.fullName) {
			toFolder.unreadEmails(toFolder.unreadEmails() + unseenCount);
		}
		toFolder.actionBlink(true);
	}

	if (messages.length) {
		disableAutoSelect(true);
		if (copy) {
			messages.forEach(item => item.checked(false));
		} else {
			MessagelistUserStore.isIncomplete(true);

			// Select next email https://github.com/the-djmaze/snappymail/issues/968
			if (currentMessage && 1 == messages.length && SettingsUserStore.showNextMessage()) {
				let next = MessagelistUserStore.indexOf(currentMessage) + 1;
				if (0 < next && (next = MessagelistUserStore()[next])) {
					currentMessage = null;
					fireEvent('mailbox.message.show', {
						folder: next.folder,
						uid: next.uid
					});
				}
			}

			messages.forEach(item => {
				if (currentMessage && currentMessage.hash === item.hash) {
					currentMessage = null;
					MessageUserStore.message(null);
				}
				MessagelistUserStore.remove(item);
			});
		}
	}

	if (toFolderFullName) {
		if (toFolder && fromFolderFullName != toFolderFullName) {
			const params =  {
				fromFolder: fromFolderFullName,
				toFolder: toFolderFullName,
				uids: [...oUids].join(',')
			};
			if (copy) {
				Remote.request('MessageCopy', copyResponseHelper, params);
			} else {
				const
					isSpam = spamFolder === toFolderFullName,
					isHam = !isSpam && spamFolder === fromFolderFullName && getFolderInboxName() === toFolderFullName;
				params.markAsRead = (isSpam || FolderUserStore.trashFolder() === toFolderFullName) ? 1 : 0;
				params.learning = isSpam ? 'SPAM' : isHam ? 'HAM' : '';
				Remote.abort('MessageList', 'reload').request('MessageMove', moveOrDeleteResponseHelper, params);
			}
		}
	} else {
		Remote.abort('MessageList', 'reload').request('MessageDelete',
			moveOrDeleteResponseHelper,
			{
				folder: fromFolderFullName,
				uids: [...oUids].join(',')
			}
		);
	}
};
