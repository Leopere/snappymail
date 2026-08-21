#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');

const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const observable = initialValue => {
	let value = initialValue;
	const result = function (nextValue) {
		if (arguments.length) {
			value = nextValue;
			return result;
		}
		return value;
	};
	return result;
};

const observableArray = (initialValue = []) => {
	const result = observable(initialValue);
	['filter', 'map', 'forEach', 'find', 'slice'].forEach(method => {
		result[method] = (...args) => result()[method](...args);
	});
	result.push = (...items) => {
		const value = result();
		value.push(...items);
		result(value);
		return value.length;
	};
	return result;
};

const source = [
	read('dev/DAV/VCardProperty.js')
		.replace('export class VCardProperty', 'class VCardProperty'),
	read('dev/DAV/JCard.js')
		.replace("import { VCardProperty } from './VCardProperty'\n", '')
		.replace('export class JCard', 'class JCard'),
	read('dev/Model/Contact.js')
		.replace(/^import .*;\n/gm, '')
		.replace('export class ContactModel', 'class ContactModel'),
	'module.exports = ContactModel;'
].join('\n');

class AbstractModel {
	static reviveFromJson(json) {
		const item = new this();
		Object.entries(json).forEach(([key, value]) => {
			if (item[key]?.subscribe) {
				item[key](value);
			}
		});
		return item;
	}
}

const context = {
	module: {exports: {}},
	ko: {observable, observableArray},
	AbstractModel,
	addObservablesTo: (target, values) => Object.entries(values).forEach(([key, value]) => {
		target[key] ||= observable(value);
	}),
	addComputablesTo: (target, values) => Object.entries(values).forEach(([key, value]) => {
		target[key] = () => value();
	})
};
vm.runInNewContext(source, context, {filename: 'ContactModel.bundle.js'});

const ContactModel = context.module.exports;
const original = ['vcard', [
	['version', {}, 'text', '4.0'],
	['n', {}, 'text', ['McArthur', 'Mike', '', '', '']],
	['fn', {}, 'text', 'Mike McArthur'],
	['email', {}, 'text', 'mike.mcarthur@boompay.ca'],
	['categories', {}, 'text', 'Team', 'Priority'],
	['categories', {type: 'work'}, 'text', 'Accounts']
]];

const categories = jCard => jCard[1]
	.filter(property => 'categories' === property[0])
	.flatMap(property => property.slice(3));

const contact = ContactModel.reviveFromJson({id: 17, jCard: original});
assert.equal(contact.favorite(), false, 'ordinary category values must not make a contact favorite');

contact.favorite(true);
let saved = JSON.parse(contact.toJSON().jCard);
assert.deepEqual(categories(saved), ['Team', 'Priority', 'Accounts', 'Favorite'],
	'favoriting must preserve every existing CATEGORIES value and append one Favorite value');
assert.deepEqual(saved[1].find(property => property[0] === 'categories' && property[3] === 'Accounts')[1], {type: 'work'},
	'favoriting must preserve category parameters');

contact.jCard = saved;
contact.favorite(false);
saved = JSON.parse(contact.toJSON().jCard);
assert.deepEqual(categories(saved), ['Team', 'Priority', 'Accounts'],
	'unfavoriting must remove only the Favorite category');

const favorited = ContactModel.reviveFromJson({
	id: 18,
	jCard: ['vcard', [
		['version', {}, 'text', '4.0'],
		['n', {}, 'text', ['Haywood', 'Kevin', '', '', '']],
		['email', {}, 'text', 'kevin.haywood@boompay.ca'],
		['categories', {}, 'text', 'favorite']
	]]
});
assert.equal(favorited.favorite(), true, 'Favorite category detection must be case-insensitive');

const contactsView = read('dev/View/Popup/Contacts.js');
assert.match(contactsView, /toggleFavorite\(contact, event\)/,
	'contacts view must expose a favorite toggle');
assert.match(contactsView, /contact\.favorite\(favorite\);\n\t\t\tthis\.sortContacts\(\);/,
	'a failed favorite save must restore the prior state');

const contactsTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/PopupsContacts.html');
assert.match(contactsTemplate, /class="favoriteContact fontastic"/,
	'contacts list must render an icon-only favorite control');
assert.match(contactsTemplate, /data-i18n="\[title\]CONTACTS\/TOGGLE_FAVORITE"/,
	'favorite control must expose a tooltip');

console.log('Contact favorites regression checks passed');
