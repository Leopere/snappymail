#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const view = read('dev/View/User/MailBox/FolderList.js');
const template = read('snappymail/v/0.0.0/app/templates/Views/User/MailFolderList.html');

assert.match(view, /isInboxView = folder => folder\.isInbox\(\)[\s\S]*?'Snoozed'[\s\S]*?archiveFolder/,
	'Inbox, Pinned, Snoozed, and Done must form one coherent primary group');
assert.match(view, /inboxFolders: \(\) => FolderUserStore\.systemFolders\(\)\.filter\(isInboxView\)/,
	'the primary Inbox group must use the explicit Inbox-view classifier');
assert.match(view, /mailFolders: \(\) => FolderUserStore\.systemFolders\(\)\.filter\(folder => !isInboxView\(folder\)\)/,
	'Sent, Drafts, Spam, and Trash must form a separate mail-management group');

const inbox = template.indexOf('foreach: inboxFolders');
const mail = template.indexOf('foreach: mailFolders');
const user = template.indexOf('foreach: folderListVisible');
assert.ok(-1 < inbox && inbox < mail && mail < user,
	'the sidebar must render Inbox views, mail-management folders, then Smart/user folders');
assert.doesNotMatch(template, /filterUnseen|SEARCH\/UNSEEN|unreadOnly/,
	'the misleading folder-only Unseen filter must not appear as an Inbox destination');
assert.match(view, /collapseSmartOnMobile\(\)[\s\S]*?smart\.collapsed\(true\)[\s\S]*?setExpandedFolder\(smart\.fullName, false\)/,
	'Smart must start collapsed on mobile without preventing a later manual expansion');

console.log('Folder pane information architecture checks passed');
