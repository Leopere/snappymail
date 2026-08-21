#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const view = read('dev/View/User/MailBox/MessageList.js');
const styles = read('dev/Styles/User/MessageList.less');
const template = read('snappymail/v/0.0.0/app/templates/Views/User/MailMessageList.html');

const classifierSource = view.match(/export const classifyMessageSwipe = ([\s\S]*?\n});/);
assert.ok(classifierSource, 'the swipe classifier must remain independently testable');
const classify = vm.runInNewContext(`(${classifierSource[1]})`);

const intentSource = view.match(/export const classifyMessageSwipeIntent = ([\s\S]*?\n});/);
assert.ok(intentSource, 'the swipe-intent classifier must remain independently testable');
const classifyIntent = vm.runInNewContext(`(${intentSource[1]})`);

const projectionSource = view.match(/export const projectMessageSwipe = ([\s\S]*?;)/);
assert.ok(projectionSource, 'the swipe dead-zone projection must remain independently testable');
const project = vm.runInNewContext(`(${projectionSource[1].slice(0, -1)})`);

assert.equal(classify(60, 390), '', 'small horizontal movement must remain a cancelled gesture');
assert.equal(classify(72, 390), 'archive', 'a short right swipe must archive');
assert.equal(classify(199, 390), 'archive', 'right swipes below the long threshold must still archive');
assert.equal(classify(200, 390), 'snooze', 'a long right swipe must request Remind/Snooze');
assert.equal(classify(-72, 390), 'delete', 'a short left swipe must delete on release');
assert.equal(classify(-200, 390), 'spam', 'a long left swipe must move to Spam');

assert.equal(classifyIntent(13, 6), '', 'minor sideways wobble must not steal a vertical scroll');
assert.equal(classifyIntent(17, 2), '', 'movement inside the intent slop must remain still');
assert.equal(classifyIntent(18, 2), 'horizontal', 'a clearly horizontal gesture must engage');
assert.equal(classifyIntent(20, 15), '', 'an ambiguous diagonal must wait for clearer intent');
assert.equal(classifyIntent(14, 20), 'vertical', 'vertical movement must cancel the row gesture');
assert.equal(classifyIntent(28, 18), 'horizontal', 'horizontal intent must win only with clear dominance');

assert.equal(project(18, 1), 0, 'engaging a swipe must not jump the row');
assert.equal(project(30, 1), 12, 'right swipes must ease smoothly out of the dead zone');
assert.equal(project(-30, -1), -12, 'left swipes must ease smoothly out of the dead zone');
assert.equal(project(-30, 1), 0, 'a swipe must not twitch across directions after locking');

assert.match(view, /else if \('delete' === action\) \{\s*this\.deleteMessage\(message, row\);/,
	'a swipe classified as Delete must commit when the pointer is released');
assert.doesNotMatch(view, /revealDelete|swipe-delete-revealed/,
	'Delete must not settle into a second-tap state');
assert.doesNotMatch(view, /action \|\|=/,
	'no action may be revealed below the release threshold');
assert.match(view, /i18n\('MESSAGE_LIST\/DELETE_PENDING'\)/,
	'Delete must retain the shared delayed Undo path');
assert.match(view, /permanentDelete[\s\S]*MessagelistUserStore\.moveMessages\(uids\.folder, uids\)/,
	'deleting from Trash or Spam must commit after Undo without a confirmation button');
assert.match(view, /fireEvent\('mailbox\.message\.snooze-request'/,
	'long-right must expose the stable Snooze integration event');
assert.match(view, /setTimeout\(\(\) => this\.commitPendingSwipeAction\(\), 5000\)/,
	'Done and Spam must keep a real five-second Undo window before the IMAP move');
assert.match(view, /undoSwipeAction\(\)/,
	'the delayed message move must expose an Undo action');
assert.match(view, /classifyMessageSwipeIntent\(horizontalDistance, verticalDistance\)/,
	'vertical scrolling must use the conservative intent classifier');
assert.match(view, /bounds = row\.getBoundingClientRect\(\)[\s\S]*?height: bounds\.height[\s\S]*?width: bounds\.width/,
	'row border-box dimensions must be measured once when the gesture starts');
assert.match(view, /projectMessageSwipe\(gesture\.distance, gesture\.direction\)/,
	'row motion must use the dead-zone projection');
assert.match(view, /directionalDistance = Math\.max\(0, distance \* gesture\.direction\)/,
	'the gesture direction must stay locked when the pointer jitters backward');
assert.match(view, /8 < Math\.max\(horizontalDistance, verticalDistance\)[\s\S]*?clearTimeout\(gesture\.longPressTimer\)/,
	'moving a finger must cancel long-press selection before gesture intent is decided');
assert.match(view, /event\.target\.closest\(interactiveSelector\)/,
	'interactive row controls must opt out of gestures');
assert.match(view, /gesture\.scrollTop = b_content\.scrollTop[\s\S]*?b_content\.classList\.add\('swipe-locked'\)/,
	'horizontal engagement must lock the list at its current scroll position');
assert.match(view, /b_content\.scrollTop !== gesture\.scrollTop[\s\S]*?b_content\.scrollTop = gesture\.scrollTop/,
	'the list must reject scroll movement throughout an active horizontal swipe');
assert.match(view, /addEventListener\('touchmove', keepSwipeScrollLocked, \{passive: false\}\)/,
	'touch scrolling must be cancellable while a horizontal swipe owns the gesture');
assert.match(view, /--message-swipe-height[\s\S]*?--message-swipe-width/,
	'the measured row dimensions must be frozen for the complete swipe');

assert.equal((template.match(/data-swipe-label="delete"/g) || []).length, 2,
	'grouped and ordinary rows must both reveal the Delete action while swiping');
assert.doesNotMatch(template, /messageSwipeDelete/,
	'Delete must not require a separate button press after release');
assert.match(template, /role="checkbox" tabindex="0" aria-label="Select message"/,
	'selection mode checkboxes must remain keyboard and screen-reader accessible');
assert.match(template, /class="messageActionUndo" role="status" aria-live="polite"/,
	'the swipe Undo result must be announced accessibly');

assert.match(styles, /overflow-x: hidden;/, 'the message list must constrain horizontal overflow');
assert.match(styles, /touch-action: pan-y pinch-zoom;/, 'rows must retain vertical scrolling and pinch zoom');
assert.match(styles, /&\.swipe-locked \{[\s\S]*?overscroll-behavior: none;[\s\S]*?touch-action: none;/,
	'the list must disable native scrolling after horizontal intent is established');
assert.match(styles, /&\.swipe-active \{[\s\S]*?height: var\(--message-swipe-height\);[\s\S]*?width: var\(--message-swipe-width\);/,
	'an active swipe must preserve the measured card border box');
assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/,
	'swipe settling animation must honor reduced-motion preferences');
assert.match(styles, /\.messageList:not\(\.mobileSelectionMode\) \.messageCheckbox/,
	'mobile row checkboxes must appear only in explicit selection mode');
assert.match(styles, /\.messageList:not\(\.mobileSelectionMode\) \.checkboxCheckAll/,
	'the mobile bulk checkbox must also stay out of the normal scanning layout');

console.log('Mobile message swipe contract checks passed');
