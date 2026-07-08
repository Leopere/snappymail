/* SnappyMail Webmail (c) SnappyMail Team | Licensed under AGPL v3 */
const fs = require('fs');
const path = require('path');

const manifestPath = path.resolve(__dirname, '../dev/Resources/keyboard-shortcuts.json');
const templatePath = path.resolve(
	__dirname,
	'../snappymail/v/0.0.0/app/templates/Views/User/PopupsKeyboardShortcutsHelp.html'
);

const startMarker = '<!-- BEGIN GENERATED SHORTCUTS -->';
const endMarker = '<!-- END GENERATED SHORTCUTS -->';

const htmlMap = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => htmlMap[char]);

const keyMarkup = key =>
	escapeHtml(key).replace(/\{meta\}/g, '<!-- ko text: metaKey --><!-- /ko -->');

const keyCell = keys =>
	keys.map(key => '<kbd>' + keyMarkup(key) + '</kbd>').join(' ');

const rowMarkup = row => [
	'\t\t\t\t<tr>',
	row.iconClass
		? '\t\t\t\t\t<td class="' + escapeHtml(row.iconClass) + '"></td>'
		: '\t\t\t\t\t<td' + (row.icon ? ' class="fontastic">' + escapeHtml(row.icon) : '>') + '</td>',
	row.label
		? '\t\t\t\t\t<td data-i18n="' + escapeHtml(row.label) + '"></td>'
		: '\t\t\t\t\t<td>' + escapeHtml(row.text) + '</td>',
	'\t\t\t\t\t<td>' + keyCell(row.keys || []) + '</td>',
	'\t\t\t\t</tr>'
].join('\n');

const tabMarkup = (tab, index) => {
	const id = 'tab-help-' + (index + 1);

	return [
		'\t\t<input type="radio" name="helptabs" id="' + id + '"' + (index ? '' : ' checked') + '>',
		'\t\t<label for="' + id + '"',
		'\t\t\trole="tab"',
		'\t\t\taria-selected="' + (index ? 'false' : 'true') + '"',
		'\t\t\taria-controls="panel-' + escapeHtml(tab.id) + '"',
		'\t\t\ttabindex="0"',
		'\t\t\tdata-i18n="' + escapeHtml(tab.label) + '"></label>',
		'\t\t<div class="tab-content" role="tabpanel" aria-hidden="' + (index ? 'true' : 'false') + '">',
		'\t\t\t<table class="table table-striped table-bordered">',
		'\t\t\t<tbody>',
		tab.rows.map(rowMarkup).join('\n'),
		'\t\t\t</tbody>',
		'\t\t\t</table>',
		'\t\t</div>'
	].join('\n');
};

const generatedMarkup = manifest => [
	startMarker,
	'\t<div class="tabs keyboard-shortcuts-generated">',
	manifest.tabs.map(tabMarkup).join('\n\n'),
	'\t</div>',
	endMarker
].join('\n');

const shortcutsHelp = done => {
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const template = fs.readFileSync(templatePath, 'utf8');
	const start = template.indexOf(startMarker);
	const end = template.indexOf(endMarker);

	if (start < 0 || end < 0 || end < start) {
		throw new Error('Shortcut help template is missing generated markers');
	}

	const next = template.slice(0, start)
		+ generatedMarkup(manifest)
		+ template.slice(end + endMarker.length);

	if (next !== template) {
		fs.writeFileSync(templatePath, next);
	}

	done && done();
};

exports.shortcutsHelp = shortcutsHelp;
