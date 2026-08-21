#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..'),
	read = file => fs.readFileSync(path.join(root, file), 'utf8'),
	storeSource = read('dev/Stores/User/Messagelist.js'),
	start = storeSource.indexOf('MessagelistUserStore.setAllSeen ='),
	end = storeSource.indexOf('/**', start),
	setAllSeenSource = storeSource.slice(start, end);

const observable = initial => {
	let value = initial;
	return function (next) {
		if (arguments.length) {
			value = next;
		}
		return value;
	};
};

const run = (error = 0, threadUids = []) => {
	const folder = { unreadEmails: observable(7) },
		requests = [],
		clears = [],
		reloads = [],
		etags = [],
		alerts = [],
		store = {
			mutationLoading: observable(false),
			clearAllSelection: value => clears.push(value),
			reload: (...args) => reloads.push(args)
		};

	vm.runInNewContext(setAllSeenSource, {
		MessagelistUserStore: store,
		Remote: {
			request: (action, callback, params) => {
				requests.push({ action, params });
				callback(error);
			}
		},
		getFolderFromCacheList: () => folder,
		setFolderETag: (...args) => etags.push(args),
		getNotification: code => `error ${code}`,
		alert: message => alerts.push(message)
	});

	store.setAllSeen('Smart.Finance', threadUids);
	return { alerts, clears, etags, folder, reloads, requests, store };
};

let result = run();
assert.equal(result.requests.length, 1, 'whole-folder read must issue one compact server request');
assert.equal(result.requests[0].action, 'MessageSetSeenToAll');
assert.equal(result.requests[0].params.folder, 'Smart.Finance');
assert.equal(result.requests[0].params.setAction, 1);
assert.equal(result.requests[0].params.threadUids, '');
assert.equal(result.folder.unreadEmails(), 0, 'folder count changes only after server success');
assert.deepEqual(result.clears, [true]);
assert.deepEqual(result.reloads, [[false, true]], 'success must reload uncached server truth');
assert.equal(result.store.mutationLoading(), false);

result = run(3);
assert.equal(result.folder.unreadEmails(), 7, 'a failed server request must not fake a local read state');
assert.deepEqual(result.etags, [['Smart.Finance', '']]);
assert.deepEqual(result.reloads, [[false, true]]);
assert.deepEqual(result.alerts, ['error 3']);

result = run(0, [17, 18]);
assert.equal(result.requests[0].params.threadUids, '17,18');
assert.equal(result.folder.unreadEmails(), 7, 'thread-only reads must not zero the whole folder count');

const setActionSource = storeSource.slice(
	storeSource.indexOf('MessagelistUserStore.setAction ='),
	storeSource.indexOf('MessagelistUserStore.moveMessages =')
);
assert.match(setActionSource,
	/if \(allSelected[\s\S]*?MessageSetAction\.SetSeen === iSetAction[\s\S]*?!MessagelistUserStore\.listSearch\(\)[\s\S]*?!MessagelistUserStore\.threadUid\(\)[\s\S]*?MessagelistUserStore\.setAllSeen\(sFolderFullName\)/,
	'ordinary Mark as read must route a complete unfiltered selection through the compact operation');

const backend = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Messages.php');
assert.match(backend,
	/DoMessageSetSeenToAll\(\)[\s\S]*?new SequenceSet\('1:\*', false\)[\s\S]*?MessageFlag::SEEN/,
	'the backend must persist the seen flag across every message sequence in the selected folder');

console.log('Bulk read server-sync regression checks passed');
