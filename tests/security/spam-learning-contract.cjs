#!/usr/bin/env node

// Copyright © 2026 ColinKnapp.com. All rights reserved.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..'),
	read = file => fs.readFileSync(path.join(root, file), 'utf8'),
	messageList = read('dev/Stores/User/Messagelist.js'),
	moveStart = messageList.indexOf('MessagelistUserStore.moveMessages ='),
	moveEnd = messageList.length,
	moveSource = messageList.slice(moveStart, moveEnd),
	actions = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Messages.php'),
	actionStart = actions.indexOf('public function DoMessageMove()'),
	actionEnd = actions.indexOf('public function DoMessageCopy()', actionStart),
	actionSource = actions.slice(actionStart, actionEnd),
	imap = read('snappymail/v/0.0.0/app/libraries/MailSo/Imap/Commands/Messages.php'),
	imapStart = imap.indexOf('public function MessageMove('),
	imapEnd = imap.indexOf('public function MessageDelete(', imapStart),
	imapMoveSource = imap.slice(imapStart, imapEnd);

assert.ok(moveStart >= 0 && moveEnd > moveStart, 'message move implementation must be present');
assert.match(moveSource,
	/isSpam = spamFolder === toFolderFullName,[\s\S]*?isHam = !isSpam && spamFolder === fromFolderFullName && getFolderInboxName\(\) === toFolderFullName/,
	'spam and ham learning must use the account configured spam and inbox folders');
assert.match(moveSource,
	/params\.learning = isSpam \? 'SPAM' : isHam \? 'HAM' : ''/,
	'moving to spam must send SPAM and moving from spam to Inbox must send HAM');

assert.ok(actionStart >= 0 && actionEnd > actionStart, 'backend message move action must be present');
assert.match(actionSource,
	/if \('SPAM' === \$sLearning\) \{[\s\S]*?MessageFlag::JUNK\);[\s\S]*?MessageFlag::NOTJUNK, false\);/,
	'SPAM learning must set $Junk and clear $NotJunk before the move');
assert.match(actionSource,
	/else if \('HAM' === \$sLearning\) \{[\s\S]*?MessageFlag::NOTJUNK\);[\s\S]*?MessageFlag::JUNK, false\);/,
	'HAM learning must set $NotJunk and clear $Junk before the move');
assert.match(actionSource,
	/MessageFlag::JUNK, false\);[\s\S]*?ImapClient\(\)->MessageMove\(/,
	'the learning keywords must be applied before the message moves');

assert.ok(imapStart >= 0 && imapEnd > imapStart, 'IMAP move implementation must be present');
assert.match(imapMoveSource,
	/if \(\$this->hasCapability\('MOVE'\)\) \{[\s\S]*?'UID MOVE' : 'MOVE'[\s\S]*?\} else \{[\s\S]*?MessageCopy\([\s\S]*?MessageDelete\(/,
	'native IMAP MOVE must remain enabled, with copy-and-delete only as its fallback');

console.log('Spam learning integration contract checks passed');
