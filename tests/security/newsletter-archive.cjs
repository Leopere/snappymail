#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'dev/App/User.js'), 'utf8');
const start = source.indexOf('\tasync moveMessagesToFolderType(');
assert(start > 0);
const method = source.slice(start, source.indexOf('\n\t/**', start + 1));
const FolderType = { Archive: 1, Inbox: 2, Junk: 3, Trash: 4 };
const newsletter = (uid = 1, threads = []) => ({ uid, folder: 'INBOX', unsubsribeLinks: () => ['https://example.test/unsubscribe'], threads: () => threads });

async function run({ messages = [newsletter()], uids = [1], archive = 'Archive', target = 'Smart.Newsletters', complete = true, switchAccount = false } = {}) {
 const moves = [], prompts = [];
 let account = 'account-a';
 const store = () => messages;
 store.moveMessages = (...args) => moves.push(args);
 const context = {
  FolderType, UNUSED_OPTION_VALUE: 'unused', MessagelistUserStore: store,
  getFolderInboxName: () => 'INBOX',
  getFolderFromCacheList: name => name && name !== 'unused' ? { fullName: name, selectable: () => true } : null,
  FolderUserStore: { archiveFolder: () => archive, spamFolder: () => 'Spam', trashFolder: () => 'Trash' },
  AccountUserStore: { email: () => account },
  setupSmartArchiveFolders: async () => { if (switchAccount) account = 'account-b'; return { complete, folders: { Newsletters: target } }; },
  showScreenPopup: (...args) => prompts.push(args), FolderSystemPopupView: 'folders', AskPopupView: 'delete', i18n: value => value
 };
 vm.createContext(context);
 vm.runInContext(`this.app = new (class { ${method} })`, context);
 await context.app.moveMessagesToFolderType(FolderType.Archive, 'INBOX', new Set(uids), false, messages);
 return { moves, prompts };
}

(async () => {
 let result = await run({ archive: 'INBOX' });
 assert.equal(result.moves[0][2], 'Smart.Newsletters', 'newsletter archive must leave Inbox even with a bad archive mapping');
 assert.equal(result.moves.length, 1);
 result = await run({ messages: [newsletter(1, [1, 2])], uids: [1, 2] });
 assert.deepEqual([...result.moves[0][1]], [1, 2], 'archive must preserve thread membership in one move');
 for (const options of [{ complete: false }, { target: 'INBOX' }, { target: 'Trash' }, { target: 'Spam' }]) {
  result = await run(options);
  assert.equal(result.moves.length, 0, 'unsafe or unavailable newsletter destination must not move/delete mail');
  assert.equal(result.prompts[0][0], 'folders');
 }
 result = await run({ messages: [newsletter(), { uid: 2, folder: 'INBOX' }], uids: [1, 2] });
 assert.equal(result.moves.length, 1, 'mixed selection must not race multiple mutations');
 assert.equal(result.moves[0][2], 'Archive', 'mixed selections retain ordinary Archive semantics');
 result = await run({ uids: [1, 99] });
 assert.equal(result.moves[0][2], 'Archive', 'unknown off-page messages must not be guessed to be newsletters');
 for (const archive of ['INBOX', 'unused']) {
  result = await run({ messages: [], archive });
  assert.equal(result.moves.length, 0, 'ordinary Archive must not target source or delete');
  assert.equal(result.prompts[0][0], 'folders');
 }
 result = await run({ switchAccount: true });
 assert.equal(result.moves.length, 0, 'folder setup must not move mail after an account switch');
 const view = fs.readFileSync(path.join(root, 'dev/View/User/MailBox/MessageView.js'), 'utf8');
 assert.match(view, /new Set\(\[message.uid\]\), bDelete, \[message\]/, 'opened message metadata must survive clearing the view');
 console.log('Newsletter archive routing checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
