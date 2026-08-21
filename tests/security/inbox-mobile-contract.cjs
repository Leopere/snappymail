#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const list = read('dev/View/User/MailBox/MessageList.js');
const store = read('dev/Stores/User/Messagelist.js');
const snooze = read('dev/Stores/User/Snooze.js');
const popup = read('dev/View/Popup/Snooze.js');
const folders = read('snappymail/v/0.0.0/app/templates/Views/User/MailFolderList.html');
const settings = read('dev/Stores/User/Settings.js');

assert.match(settings, /useThreads: 1/,
	'conversation threading must be the client default');
assert.match(settings, /threadAlgorithm: 'REFS'/,
	'REFS must be the normalized conversation default');
assert.match(store, /\[message\.uid, \.\.\.message\.threads\(\)\]/,
	'read, unread, pin, and delete flag actions must expand conversation UIDs');

assert.match(folders, /class="selectable pinnedShortcut"/,
	'Pinned must be a first-class Inbox destination');
assert.match(list, /FolderType\.Archive, i18n\('MESSAGE_LIST\/DONE_PENDING'\)/,
	'Done must use the configured Archive folder');

assert.match(snooze, /addEventListener\('mailbox\.message\.snooze-request'/,
	'the gesture event must open the Snooze flow');
assert.match(snooze, /Remote\.request\('SnoozeProcessDue'/,
	'an authenticated session must process due reminders');
assert.match(popup, /Remote\.request\('SnoozeCreate'/,
	'the Remind picker must persist a Snooze operation');
assert.match(popup, /uids: Array\.isArray\(request\.uids\)/,
	'the Snooze request must carry the complete folder-local conversation');

console.log('Inbox mobile contract checks passed');
