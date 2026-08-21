const fs = require('fs');
const { execFileSync } = require('child_process');

const envFile = process.env.SNAPPYMAIL_AUDIT_ENV || '/Users/aedev/.config/codex/snappymail-miab-audit-users.env';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const baseUrl = 'https://box.p.nixc.us';

const parseEnvFile = file => {
	if (!fs.existsSync(file)) {
		throw new Error(`Missing audit env file: ${file}`);
	}
	return Object.fromEntries(
		fs.readFileSync(file, 'utf8')
			.split(/\n/)
			.map(line => line.match(/^export\s+([A-Z0-9_]+)='([^']*)'$/))
			.filter(Boolean)
			.map(([, key, value]) => [key, value])
	);
};

const compactUtc = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

const request = (user, password, method, path, body = '', headers = []) => {
	const args = [
		'-4', '--connect-timeout', '5', '--max-time', '20', '-sS',
		'-u', user + ':' + password,
		'-X', method
	];
	for (const header of headers) {
		args.push('-H', header);
	}
	if (body) {
		args.push('--data-binary', body);
	}
	args.push('-w', '\n%{http_code}', baseUrl + path);
	const output = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).replace(/\s+$/, '');
	const match = output.match(/\n(\d{3})$/);
	if (!match) {
		throw new Error('CalDAV response did not include an HTTP status.');
	}
	return { body: output.slice(0, -match[0].length), status: Number(match[1]) };
};

const calendarQuery = (start, end) => [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
	'<d:prop><d:getetag/><c:calendar-data/></d:prop>',
	'<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">',
	'<c:time-range start="' + start + '" end="' + end + '"/>',
	'</c:comp-filter></c:comp-filter></c:filter>',
	'</c:calendar-query>'
].join('');

const eventData = (uid, start, end, email) => [
	'BEGIN:VCALENDAR',
	'VERSION:2.0',
	'PRODID:-//SnappyMail Audit//EN',
	'BEGIN:VEVENT',
	'UID:' + uid,
	'DTSTAMP:' + compactUtc(new Date()),
	'DTSTART:' + start,
	'DTEND:' + end,
	'SUMMARY:SnappyMail CalDAV conflict fixture',
	'ORGANIZER:mailto:' + email,
	'END:VEVENT',
	'END:VCALENDAR',
	''
].join('\r\n');

const auditAccount = (label, email, password) => {
	const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
	const end = new Date(start.getTime() + 30 * 60 * 1000);
	const startValue = compactUtc(start);
	const endValue = compactUtc(end);
	const uid = 'snappymail-audit-conflict-' + label + '-' + runId + '@audit.local';
	const path = '/cloud/remote.php/caldav/calendars/' + encodeURIComponent(email) + '/personal/' + encodeURIComponent(uid) + '.ics';
	let putStatus = 0;
	let reportStatus = 0;
	let deleteStatus = 0;
	let conflictFound = false;
	try {
		putStatus = request(email, password, 'PUT', path, eventData(uid, startValue, endValue, email), [
			'Content-Type: text/calendar; charset=utf-8',
			'If-None-Match: *'
		]).status;
		if (![200, 201, 204].includes(putStatus)) {
			throw new Error(label + ' CalDAV fixture PUT returned HTTP ' + putStatus + '.');
		}
		const report = request(email, password, 'REPORT', path.replace(/[^/]+$/, ''), calendarQuery(startValue, endValue), [
			'Depth: 1',
			'Content-Type: application/xml; charset=utf-8'
		]);
		reportStatus = report.status;
		conflictFound = 207 === reportStatus && report.body.includes(uid);
		if (!conflictFound) {
			throw new Error(label + ' CalDAV time-range report did not return the overlapping audit event.');
		}
	} finally {
		const deleted = request(email, password, 'DELETE', path);
		deleteStatus = deleted.status;
		if (![200, 204, 404].includes(deleteStatus)) {
			throw new Error(label + ' CalDAV fixture DELETE returned HTTP ' + deleteStatus + '.');
		}
	}
	return { label, putStatus, reportStatus, conflictFound, deleteStatus };
};

const main = () => {
	const env = parseEnvFile(envFile);
	const pairs = [
		['boompay', env.SNAPPYMAIL_AUDIT_BOOMPAY_B_EMAIL, env.SNAPPYMAIL_AUDIT_BOOMPAY_B_PASSWORD],
		['nixc', env.SNAPPYMAIL_AUDIT_NIXC_B_EMAIL, env.SNAPPYMAIL_AUDIT_NIXC_B_PASSWORD]
	];
	const results = pairs.map(([label, email, password]) => {
		if (!email || !password) {
			throw new Error('Missing audit credentials for ' + label + '.');
		}
		return auditAccount(label, email, password);
	});
	console.log(JSON.stringify({ runId, results }, null, 2));
};

try {
	main();
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
