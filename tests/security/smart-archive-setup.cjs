#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..'),
	read = file => fs.readFileSync(path.join(root, file), 'utf8'),
	source = read('dev/Classifier/SmartArchiveSetup.js')
		.replace(/^import .*;\n/gm, '')
		.replace(/export const\b/g, 'const')
		.replace(/export function\b/g, 'function')
		+ '\nmodule.exports = { SMART_ARCHIVE_FOLDER_NAMES, setupSmartArchiveFolders };';

const observable = initial => {
	let value = initial;
	return function (next) {
		if (arguments.length) {
			value = next;
		}
		return value;
	};
};

const makeFolder = (name, fullName, parentName = '', children = [], subscribed = true) => {
	const subFolders = () => children;
	subFolders.allow = true;
	return {
		name: () => name,
		fullName,
		parentName,
		subFolders,
		isSubscribed: observable(subscribed),
		collapsed: observable(true)
	};
};

let roots = [], folderMap = new Map, createCalls = [], subscribeCalls = [], expanded = [];
const folderList = () => roots;
folderList.allow = true;

const install = nextRoots => {
	roots = nextRoots;
	folderMap = new Map;
	const walk = folders => folders.forEach(folder => {
		folderMap.set(folder.fullName, folder);
		walk(folder.subFolders());
	});
	walk(roots);
};


const smartTree = (subscribed = true, topLevel = false) => {
	const prefix = topLevel ? 'Smart' : 'Archive.Smart';
	const children = ['Finance', 'Newsletters', 'Notifications', 'Security']
		.map(name => makeFolder(name, `${prefix}.${name}`, prefix, [], subscribed)),
		smart = makeFolder('Smart', prefix, topLevel ? '' : 'Archive', children, subscribed);
	return topLevel ? smart : makeFolder('Archive', 'Archive', '', [smart], subscribed);
};

const context = {
	module: { exports: {} },
	getFolderFromCacheList: name => folderMap.get(name),
	setExpandedFolder: (name, value) => expanded.push([name, value]),
	loadFolders: callback => {
		install([smartTree()]);
		callback(true);
	},
	Remote: {
		post: async (action, loading, data) => {
			createCalls.push({ action, ...data });
			return { Result: { fullName: data.parent ? `${data.parent}.${data.folder}` : data.folder } };
		},
		request: (action, callback, data) => {
			subscribeCalls.push({ action, ...data });
			callback(0);
		}
	},
	FolderUserStore: {
		archiveFolder: () => 'Archive',
		folderList
	},
	ThemeStore: {
		isMobile: () => true
	}
};

vm.runInNewContext(source, context, { filename: 'Classifier/SmartArchiveSetup.js' });
const { SMART_ARCHIVE_FOLDER_NAMES, setupSmartArchiveFolders } = context.module.exports;

(async () => {
	assert.deepEqual(Array.from(SMART_ARCHIVE_FOLDER_NAMES),
		['Finance', 'Newsletters', 'Notifications', 'Security']);

	install([smartTree()]);
	let result = await setupSmartArchiveFolders();
	assert.equal(result.complete, true, 'an existing subscribed hierarchy must be accepted');
	assert.equal(createCalls.length, 0, 'idempotent setup must not recreate existing folders');
	assert.equal(subscribeCalls.length, 0, 'idempotent setup must not resubscribe existing folders');
	assert.deepEqual(expanded, [['Archive.Smart', false]],
		'setup must collapse the secondary Smart folder on mobile');

	createCalls = [];
	subscribeCalls = [];
	expanded = [];
	install([smartTree(true, true), makeFolder('Archive', 'Archive')]);
	result = await setupSmartArchiveFolders();
	assert.equal(result.complete, true, 'an existing top-level Smart hierarchy must be accepted');
	assert.equal(result.folders.Finance, 'Smart.Finance');
	assert.equal(createCalls.length, 0, 'top-level Smart folders must not trigger Archive.Smart duplicates');
	assert.equal(subscribeCalls.length, 0, 'subscribed top-level Smart folders must be left intact');
	assert.deepEqual(expanded, [['Smart', false]],
		'setup must collapse the top-level Smart container on mobile');

	createCalls = [];
	subscribeCalls = [];
	expanded = [];
	install([makeFolder('Archive', 'Archive')]);
	result = await setupSmartArchiveFolders();
	assert.equal(result.complete, true, 'missing Smart Archive folders must be created');
	assert.deepEqual(createCalls.map(call => [call.folder, call.parent, call.subscribe]), [
		['Smart', 'Archive', 1],
		...Array.from(SMART_ARCHIVE_FOLDER_NAMES, name => [name, 'Archive.Smart', 1])
	]);

	createCalls = [];
	subscribeCalls = [];
	expanded = [];
	install([smartTree(false)]);
	result = await setupSmartArchiveFolders();
	assert.equal(result.complete, true, 'an unsubscribed hierarchy must be repaired');
	assert.equal(createCalls.length, 0, 'subscription repair must not create duplicates');
	assert.equal(subscribeCalls.length, SMART_ARCHIVE_FOLDER_NAMES.length + 2,
		'every required container and destination must be subscribed');
	assert(subscribeCalls.every(call => 'FolderSubscribe' === call.action && 1 === call.subscribe));

	const accountSettings = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Accounts.php'),
		userSettings = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/User.php'),
		userApp = read('dev/App/User.js'),
		classifier = read('dev/Classifier/EmailClassifier.js'),
		folderSettings = read('dev/Settings/User/Folders.js'),
		folderTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/SettingsFolders.html'),
		folderList = read('dev/View/User/MailBox/FolderList.js'),
		folderItem = read('snappymail/v/0.0.0/app/templates/Views/User/MailFolderListItem.html'),
		messageList = read('dev/View/User/MailBox/MessageList.js'),
		messageStore = read('dev/Stores/User/Messagelist.js'),
		messageTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/MailMessageList.html'),
		localization = JSON.parse(read('snappymail/v/0.0.0/app/localization/en/user.json'));

	assert.match(accountSettings, /'colin@nixc\.us' === \$email/,
		'colin@nixc.us must receive the enabled default');
	assert.match(accountSettings, /str_ends_with\(\$email, '@boompay\.ca'\)/,
		'BoomPay accounts must receive the enabled default');
	assert.match(accountSettings, /GetConf\(\s*'SmartArchiveEnabled'/,
		'a saved opt-out must override the account default');
	assert.match(userSettings, /setSettingsFromParams\(\$oSettingsLocal, 'SmartArchiveEnabled', 'bool'\)/,
		'the enable switch must persist server-side');
	assert.match(userApp, /smartArchiveEnabled\(\) && await setupSmartArchiveFolders\(\)/,
		'enabled accounts must repair setup before mailbox screens start');
	assert.match(classifier, /if \(!SettingsUserStore\.smartArchiveEnabled\(\)\) \{\s*return;/,
		'disabled accounts must not run classification');
	const automaticPersistence = classifier.match(/persistAutomaticCategory = \(message, result\) => \{[\s\S]*?\n\t\};/)?.[0] || '';
	assert.doesNotMatch(automaticPersistence, /routeMessageCategory/,
		'automatic suggestions must never move mail');
	assert.match(folderSettings, /value && this\.autoConfigureSmartArchive\(\)/,
		'enabling the switch must immediately configure folders');
	assert.match(folderTemplate, /SETTINGS_FOLDERS\/SMART_ARCHIVE_ENABLE/,
		'folder settings must expose the enable switch');
	assert.match(folderItem, /visible: hasUnreadInSub\(\) &amp;&amp; !canBeSelected\(\)/,
		'non-selectable containers with unread descendants must expose the bulk-read action');
	assert.match(folderList, /markFolderTreeRead\(folder, event\)[\s\S]*?MessageSetSeenToAll/,
		'folder-tree bulk read must use the existing whole-folder seen action');
	assert.match(messageTemplate, /listSelectionNotice allSelected[\s\S]*?click: listSetAllSeen[\s\S]*?MARK_FOLDER_READ/,
		'a whole-folder read action must be visible beside the complete selection notice');
	assert.match(messageList, /listSetAllSeen\(\)[\s\S]*?MessagelistUserStore\.setAllSeen/,
		'the visible action must use the shared server-authoritative operation');
	assert.match(messageStore, /if \(allSelected[\s\S]*?MessageSetAction\.SetSeen === iSetAction[\s\S]*?MessagelistUserStore\.setAllSeen\(sFolderFullName\)/,
		'the ordinary Mark as read command must use whole-folder IMAP when the full folder is selected');
	assert.match(messageStore, /setAllSeen = \(folderName, threadUids = \[\]\)[\s\S]*?Remote\.request\('MessageSetSeenToAll'[\s\S]*?MessagelistUserStore\.reload\(false, true\)/,
		'bulk read must wait for server success and reload server truth');
	assert.equal(localization.MESSAGE_LIST.MARK_FOLDER_READ, 'Mark whole folder as read');
	assert.equal(localization.FOLDER_LIST.MARK_SUBFOLDERS_READ, 'Mark all subfolders as read');

	console.log('Smart Archive self-setup regression checks passed');
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
