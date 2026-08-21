#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const template = read('snappymail/v/0.0.0/app/templates/Views/User/MailMessageView.html');
const styles = read('dev/Styles/User/MessageView.less');
const systemStyles = read('dev/Styles/User/SystemDropDown.less');
const navigationEnd = template.indexOf('<div class="messageView">');
const navigation = template.slice(0, navigationEnd);
const menuStart = template.indexOf('<menu class="dropdown-menu right-edge message-actions-menu"');
const menuEnd = template.indexOf('</menu>', menuStart);
const menu = template.slice(menuStart, menuEnd);
const openPgpStatusStart = template.indexOf('<div class="crypto-status-group" aria-label="OpenPGP status"');
const openPgpStatusEnd = template.indexOf('<div class="crypto-status-group" aria-label="S/MIME status"', openPgpStatusStart);
const openPgpStatus = template.slice(openPgpStatusStart, openPgpStatusEnd);
const mobileStylesStart = styles.indexOf('@media screen and (max-width: @maxMobileWidth)');
const mobileStylesEnd = styles.indexOf('@media screen and (max-width: 1400px)', mobileStylesStart);
const mobileStyles = styles.slice(mobileStylesStart, mobileStylesEnd);

assert.ok(menuStart > -1 && menuEnd > menuStart,
	'the opened message needs one bounded More-actions menu');
assert.strictEqual((template.match(/class="messageItemHeader message-reading-header"/g) || []).length, 1,
	'message identity and metadata must live in one reading header');
assert.match(template, /class="top-toolbar message-navigation-bar/,
	'close and previous/next controls must form a dedicated navigation bar');
for (const glyph of ['✖', '❮', '❯', '🗄', '🗑']) {
	assert.ok(navigation.includes(glyph),
		`the top toolbar must use the mapped ${glyph} icon-font glyph`);
}
assert.doesNotMatch(navigation, /[×‹›✓]/,
	'the top toolbar must not mix unsupported fallback glyphs into the icon font');
assert.match(template, /class="btn message-primary-action buttonReply"/,
	'Reply must be the clear primary message action');
assert.match(template, /class="btn dropdown-toggle message-more-button"/,
	'secondary abilities must remain discoverable behind a labelled More control');
assert.match(template, /class="message-identity-main"/,
	'sender details must remain one coherent identity group');
assert.match(template, /class="message-identity-actions"/,
	'the date and reading actions must remain one coherent action group');
assert.doesNotMatch(template, /<select class="messageCategoryPicker"/,
	'the category correction control must not compete with primary reading actions');
assert.match(menu, /<details class="messageCategoryPicker"/,
	'category correction must remain available through progressive disclosure');
assert.match(menu, /Applies a durable mail label\. Routed Inbox categories also move the message\./,
	'the category control must explain its durable and routing effects');

for (const label of ['Respond', 'Organize', 'View', 'Message file']) {
	assert.match(menu, new RegExp(`aria-label="${label}"`),
		`the More menu must expose a ${label} group`);
}

for (const action of [
	'command: replyCommand',
	'command: replyAllCommand',
	'command: forwardCommand',
	'command: forwardAsAttachmentCommand',
	'command: editAsNewCommand',
	'click: setUnseen',
	'command: archiveCommand',
	'command: moveCommand',
	'command: copyCommand',
	'command: spamCommand',
	'command: notSpamCommand',
	'command: deleteCommand',
	'command: undeleteCommand',
	'command: deleteWithoutMoveCommand',
	'click: printMessage',
	'click: $root.toggleFullScreen',
	'click: popupMessage',
	'click: viewHtml',
	'click: viewPlain',
	'click: swapColors',
	'href: viewRaw()',
	'href: downloadLink()'
]) {
	const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	assert.strictEqual((menu.match(new RegExp(escaped, 'g')) || []).length, 1,
		`${action} must remain available exactly once in the More menu`);
}

assert.match(menu, /class="message-action-danger"[^>]*deleteWithoutMoveCommand/,
	'permanent deletion must remain available but receive distinct danger styling');
assert.strictEqual((template.match(/class="crypto-status-group"/g) || []).length, 2,
	'OpenPGP and S/MIME results must each use one compact status group');
assert.strictEqual((template.match(/text: pgpEncryptionStatusText/g) || []).length, 1,
	'the OpenPGP encryption result must be rendered exactly once');
assert.match(template, /text: pgpSignatureStatusText/);
assert.doesNotMatch(openPgpStatus, /message\(\)\.pgpEncrypted\(\)\?\.error/,
	'the OpenPGP encryption helper already includes a real failure and must not render it twice');
assert.match(styles, /\.message-actions-menu[\s\S]*width: 304px/);
assert.match(styles, /position: fixed !important[\s\S]*right: 8px !important[\s\S]*top: auto !important/,
	'the phone More menu must become a viewport-constrained bottom sheet');
assert.match(mobileStyles, /\.message-actions-menu[\s\S]*left:\s*8px !important[\s\S]*max-width:\s*none[\s\S]*right:\s*8px !important[\s\S]*width:\s*auto/,
	'the mobile More sheet must override the generic 90vw dropdown cap and keep equal viewport margins');
assert.match(styles, /\.message-header-close\s*\{[\s\S]*?display:\s*none/,
	'the compact header Close control must be hidden whenever the top navigation remains visible');
assert.doesNotMatch(mobileStyles, /\.message-header-close\s*\{[^}]*display:\s*inline-flex/,
	'the normal mobile message view must not duplicate the Close action from its visible top toolbar');
assert.match(styles, /html\.sm-msgView-side #V-MailMessageView \.message-header-close\s*\{[\s\S]*?display:\s*inline-flex/,
	'the compact close action must remain available when side-view mode hides the top toolbar');
assert.match(styles, /\.message-fixed-button-toolbar[\s\S]*display: flex/);
assert.doesNotMatch(styles, /\.message-fixed-button-toolbar\s*\{[^}]*position:\s*absolute/,
	'the primary actions must participate in header layout instead of floating over content');
assert.match(styles, /\.message-identity-row\s*\{[\s\S]*?display:\s*flex/,
	'the identity row must size its two semantic groups from their content');
assert.match(styles, /\.message-identity-row\s*\{[\s\S]*?flex-wrap:\s*wrap/,
	'the two identity groups must wrap intact before causing horizontal overflow');
assert.doesNotMatch(styles, /\.message-identity-row\s*\{[^}]*grid-template-columns/,
	'the identity row must not reserve a wide empty grid track between sender and actions');
assert.match(styles, /\.message-identity-main\s*\{[\s\S]*?max-width:\s*720px/,
	'long sender details must remain bounded without forcing a 720px empty column');
assert.match(styles, /\.message-identity-actions\s*\{[\s\S]*?flex:\s*0 0 auto/,
	'date and actions must stay together when sender details shrink');
assert.match(styles, /@media screen and \(max-width: @maxMobileWidth\)[\s\S]*?\.message-identity-row\s*\{[\s\S]*?flex-direction:\s*column/,
	'the identity and actions groups must stack predictably on phones');
assert.match(styles, /\.messageAssignedTags\s*\{\s*flex:\s*0 1 auto/,
	'the tags control must remain beside assigned tags instead of being pushed across the header');
assert.match(styles, /#V-MailMessageView \.top-toolbar[\s\S]*justify-content:\s*flex-start/,
	'message navigation and actions must stay in one left-aligned rail');
assert.match(styles, /\.message-navigation-leading \.btn,[\s\S]*width:\s*36px/,
	'top toolbar icon buttons must have one exact square size');
assert.match(systemStyles, /#V-SystemDropDown[\s\S]*left:\s*0[\s\S]*pointer-events:\s*none[\s\S]*right:\s*0[\s\S]*width:\s*100%/,
	'the system dropdown view must span the row without blocking message controls');
assert.match(systemStyles, /> \.btn-toolbar[\s\S]*pointer-events:\s*auto/,
	'only the system dropdown controls may capture clicks in its full-width overlay');
assert.match(systemStyles, /#top-system-dropdown-id[\s\S]*height:\s*36px/,
	'the account control must share the message toolbar button height');

console.log('Message view information architecture checks passed');
