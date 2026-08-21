#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const params = read('snappymail/v/0.0.0/app/libraries/MailSo/Mail/MessageListParams.php');
const mailClient = read('snappymail/v/0.0.0/app/libraries/MailSo/Mail/MailClient.php');
const applicationConfig = read('snappymail/v/0.0.0/app/libraries/RainLoop/Config/Application.php');
const appDataActions = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php');
const actions = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Messages.php');
const messageModel = read('dev/Model/Message.js');
const messageView = read('dev/View/User/MailBox/MessageView.js');
const folderStore = read('dev/Stores/User/Folder.js');
const view = read('dev/View/User/MailBox/MessageList.js');
const template = read('snappymail/v/0.0.0/app/templates/Views/User/MailMessageList.html');
const boomPayManifest = read('snappymail/v/0.0.0/static/brand/boompay-manifest.json');
const mrcManifest = read('snappymail/v/0.0.0/static/brand/mrc-manifest.json');

assert.match(applicationConfig, /'request_read_receipt'\s*=>\s*array\(true,/,
	'read-receipt requests must be enabled in the administrator-controlled product defaults');
assert.match(appDataActions,
	/GetConf\(\s*'requestReadReceipt',\s*\$oConfig->Get\('defaults', 'request_read_receipt', true\)\s*\)/,
	'an unset user preference must inherit the administrator default while an explicit false still wins');

assert.match(params, /\$bHideDeliveryReceipts = false/,
	'receipt hiding must be an explicit message-list behavior');
assert.match(params, /\$this->bHideDeliveryReceipts \? '1' : '0'/,
	'receipt-hidden and receipt-visible lists must not share cache keys');
assert.match(actions, /strcasecmp\(\$oParams->sFolderName, 'INBOX'\)[\s\S]*?'' === \\trim\(\$oParams->sSearch\)[\s\S]*?!\$oParams->iThreadUid/,
	'only the ordinary Inbox view may suppress delivery receipts');

assert.match(mailClient, /HEADER Content-Type "multipart\/report" SUBJECT "Successful Mail Delivery Report"/,
	'success receipts must require both the DSN MIME type and exact Postfix subject');
assert.match(mailClient, /HEADER Content-Type "disposition-notification"/,
	'standards-based message disposition notifications must allow valid quoted or spaced report-type parameters');
assert.match(mailClient, /prepend\('NOT \(' \. self::SUCCESSFUL_DELIVERY_RECEIPT_SEARCH \. '\)'\)/,
	'the ordinary message list must exclude successful DSNs at the IMAP query');
assert.match(mailClient, /prepend\('NOT \(' \. self::READ_RECEIPT_SEARCH \. '\)'\)/,
	'the ordinary message list must exclude raw read receipts at the IMAP query');
assert.match(mailClient, /UNKEYWORD ' \. \$sProcessedFlag/,
	'only receipts not yet processed may be reparsed');
assert.match(mailClient, /ReceiptPartHeaders\(\$sFolderName, \$aReceiptUids, \['text\/rfc822-headers'\]\)/,
	'the original-message header attachment must drive exact correlation');
assert.match(mailClient, /ValueByName\(MimeHeader::MESSAGE_ID\)/,
	'the receipt must use the original Message-ID instead of guessing by subject');
assert.match(mailClient, /SearchByContentType\(\$sContentType\)[\s\S]*?message\/disposition-notification/,
	'read receipt correlation must parse the machine-readable MDN part');
assert.match(mailClient, /ValueByName\('Original-Message-ID'\)/,
	'read receipt correlation must use the MDN original Message-ID');
assert.match(mailClient, /preg_match\('\/;\\s\*displayed/,
	'only a displayed disposition may mark a Sent item as read');
assert.match(mailClient, /HEADER Message-ID[\s\S]*?DELIVERY_SUCCESS_FLAG/,
	'the matching Sent item must receive a durable delivery-success keyword');
assert.match(mailClient, /DELIVERY_RECEIPT_PROCESSED_FLAG/,
	'a parsed raw delivery receipt must be marked as processed');
assert.match(mailClient, /READ_RECEIPT_PROCESSED_FLAG[\s\S]*?READ_SUCCESS_FLAG/,
	'a parsed MDN must persist separate processed and read-success keywords');
assert.match(mailClient, /new SequenceSet\(\$aPendingReceiptUids\)[\s\S]*?\$sProcessedFlag/,
	'malformed and unmatched reports must not be reparsed on every Inbox load');
assert.match(mailClient, /DecodeEncodingValue/,
	'internationalized MDN bodies must be decoded before their fields are parsed');
assert.match(mailClient, /MessageFlag::SEEN/,
	'success receipts must become read before new-message notifications are assembled');
assert.doesNotMatch(mailClient, /PrepareDeliveryReceipts[\s\S]*?MessageMove/,
	'receipts must remain stored instead of being moved or deleted');

assert.match(messageView, /messageId: oMessage\.messageId/,
	'generated MDNs must receive the original message identifier from the viewed message');
assert.match(actions, /MailClient\(\)->Message\([\s\S]*?\$aOriginalMessage\['readReceipt'\][\s\S]*?\$aOriginalMessage\['messageId'\]/,
	'the server must bind the MDN destination and original identifier to the stored source message');
assert.match(actions, /multipart\/report; report-type=disposition-notification/,
	'generated read receipts must use the RFC 8098 multipart report type');
assert.match(actions, /Original-Message-ID: /,
	'generated read receipts must carry the original message identifier');
assert.match(actions, /Disposition: manual-action\/MDN-sent-manually; displayed/,
	'generated read receipts must declare the displayed disposition');
assert.match(actions, /\$bNullSender \|\| !empty\(\$sFrom\)/,
	'generated MDNs must support the required null SMTP envelope sender');

assert.match(messageModel, /deliverySucceeded:\s*\(\) => this\.flags\(\)\.includes\('\$deliverysuccess'\)/,
	'the message model must expose delivery state from its persisted keyword');
assert.match(messageModel, /readSucceeded:\s*\(\) => this\.flags\(\)\.includes\('\$readsuccess'\)/,
	'the message model must expose displayed state from its persisted keyword');
assert.match(folderStore, /'\$deliverysuccess'/,
	'the internal delivery keyword must not appear as a user tag');
assert.match(folderStore, /'\$readsuccess'/,
	'the internal read keyword must not appear as a user tag');
assert.equal((template.match(/deliverySuccessIcon/g) || []).length, 2,
	'grouped and ordinary Sent rows must both render the per-message success control');
assert.equal((template.match(/readSuccessIcon/g) || []).length, 2,
	'grouped and ordinary Sent rows must both render the per-message read control');
assert.equal((template.match(/deliverySucceeded\(\) &amp;&amp; !readSucceeded\(\)/g) || []).length, 2,
	'the stronger read status must visually supersede delivery without adding clutter');
assert.match(view, /deliveryReceiptLabel = i18n\('MESSAGE_LIST\/DELIVERY_RECEIPT_RECEIVED'\)/,
	'the per-message icon label must be localized');
assert.equal((template.match(/'aria-label': \$root\.deliveryReceiptLabel/g) || []).length, 2,
	'the per-message icon must explain itself to mouse and assistive-technology users');
assert.equal((template.match(/'aria-label': \$root\.readReceiptLabel/g) || []).length, 2,
	'the read icon must explain itself to mouse and assistive-technology users');
assert.doesNotMatch(template, /deliveryReceiptSummary/,
	'the generic toolbar receipt badge must not remain after exact message correlation');
assert.match(view, /showMessageReceipts\(message, event\)[\s\S]*?Content-Type multipart\/report[\s\S]*?body:"\$\{messageId\}"/,
	'clicking either status must reveal only that message\'s retained raw reports');
assert.doesNotMatch(`${boomPayManifest}\n${mrcManifest}`, /\/snappymail\/v\/0\.0\.0\//,
	'PWA manifest icons must resolve beside the released versioned manifest');

console.log('Per-message delivery and read receipt contract checks passed');
