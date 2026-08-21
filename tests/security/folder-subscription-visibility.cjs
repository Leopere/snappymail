#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const folderModel = read('dev/Model/FolderCollection.js');
const folderList = read('dev/View/User/MailBox/FolderList.js');
const folderItem = read('snappymail/v/0.0.0/app/templates/Views/User/MailFolderListItem.html');
const settingsTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/SettingsFolders.html');
const localization = JSON.parse(read('snappymail/v/0.0.0/app/localization/en/user.json'));

assert.match(folderModel, /hasVisibleSubfolders: \(\) => !!this\.subFolders\(\)\.find\(folder => folder\.visible\(\)\)/,
	'folder visibility must recurse through unsubscribed or non-selectable parent containers');
assert.match(folderModel, /return this\.hasVisibleSubfolders\(\) \| visible;/,
	'a parent container must remain visible whenever it has a visible descendant');
assert.match(folderList, /systemNames = new Set\(FolderUserStore\.systemFoldersNames\(\)\)/,
	'the ordinary folder tree must identify folders already rendered in the system section');
assert.match(folderList, /systemNames\.has\(folder\.fullName\)[\s\S]*?folder\.visibleSubfolders\(\)/,
	'a system folder must render its visible descendants without appearing twice itself');
assert.doesNotMatch(folderList, /filter\(folder => !systemNames\.has\(folder\.fullName\)\)/,
	'system roots must be flattened rather than discarded with their subscribed descendants');
assert.match(folderItem, /foreach: visibleSubfolders/,
	'the mailbox tree must render visible descendants recursively');
assert.match(settingsTemplate, /SETTINGS_FOLDERS\/HIDE_UNSUBSCRIBED_DESC/,
	'folder settings must explain the descendant-preserving behavior');
assert.match(localization.SETTINGS_FOLDERS.HIDE_UNSUBSCRIBED_DESC, /Parent containers stay visible/,
	'the English help text must explain why an unsubscribed parent can remain visible');

console.log('Folder subscription visibility regression checks passed');
