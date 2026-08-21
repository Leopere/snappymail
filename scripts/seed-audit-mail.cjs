const fs = require('fs');
const tls = require('tls');

const envFile = process.env.SNAPPYMAIL_AUDIT_ENV || '/Users/aedev/.config/codex/snappymail-miab-audit-users.env';
const countArg = process.argv.find(arg => arg.startsWith('--count='));
const domainArg = process.argv.find(arg => arg.startsWith('--domain='));
const count = Math.max(1, Math.min(100, parseInt(countArg?.slice(8), 10) || 30));
const requestedDomain = domainArg?.slice(9) || '';
const calendar = process.argv.includes('--calendar');
const runId = new Date().toISOString().replace(/[:.]/g, '-');

const parseEnvFile = file => {
	if (!fs.existsSync(file)) {
		throw new Error(`Missing audit env file: ${file}`);
	}

	const values = {};
	for (const line of fs.readFileSync(file, 'utf8').split(/\n/)) {
		const match = line.match(/^export\s+([A-Z0-9_]+)='([^']*)'$/);
		if (match) {
			values[match[1]] = match[2];
		}
	}
	return values;
};

const expectCode = (response, expected, action) => {
	if (!expected.includes(response.code)) {
		throw new Error(`SMTP ${action} failed with ${response.code}.`);
	}
};

const connectSmtp = () => new Promise((resolve, reject) => {
	const socket = tls.connect({
		host: 'box.p.nixc.us',
		port: 465,
		servername: 'box.p.nixc.us',
		rejectUnauthorized: true
	});

	let buffer = '';
	let pending = null;
	let lines = [];

	const consume = () => {
		while (pending) {
			const end = buffer.indexOf('\r\n');
			if (-1 === end) {
				return;
			}
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const match = line.match(/^(\d{3})([ -])/);
			if (!match) {
				pending.reject(new Error('Malformed SMTP response.'));
				pending = null;
				return;
			}
			lines.push(line);
			if (' ' === match[2]) {
				const current = pending;
				pending = null;
				current.resolve({ code: parseInt(match[1], 10), lines });
				lines = [];
			}
		}
	};

	socket.once('error', reject);
	socket.once('secureConnect', () => {
		socket.removeListener('error', reject);
		socket.on('data', chunk => {
			buffer += chunk.toString('utf8');
			consume();
		});
		socket.on('error', error => pending?.reject(error));
		resolve({
			socket,
			read: () => new Promise((resolveRead, rejectRead) => {
				if (pending) {
					rejectRead(new Error('Concurrent SMTP reads are not supported.'));
					return;
				}
				pending = { resolve: resolveRead, reject: rejectRead };
				consume();
			})
		});
	});
});

const readCommand = async (client, value, expected, action) => {
	client.socket.write(`${value}\r\n`);
	const response = await client.read();
	expectCode(response, expected, action);
	return response;
};

const deliverMessage = async (client, sender, recipient, message) => {
	await readCommand(client, `MAIL FROM:<${sender}>`, [250], 'MAIL FROM');
	await readCommand(client, `RCPT TO:<${recipient}>`, [250, 251], 'RCPT TO');
	await readCommand(client, 'DATA', [354], 'DATA');
	client.socket.write(`${message.replace(/^\./gm, '..')}\r\n.\r\n`);
	expectCode(await client.read(), [250], 'message delivery');
};

const sendMessage = async (client, sender, recipient, subject, body) => {
	const message = [
		`From: <${sender}>`,
		`To: <${recipient}>`,
		`Subject: ${subject}`,
		`Message-ID: <${runId}-${Math.random().toString(16).slice(2)}@audit.local>`,
		`X-Snappy-Audit-Run: ${runId}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		body
	].join('\r\n');
	await deliverMessage(client, sender, recipient, message);
};

const iCalendarTimestamp = date => date.toISOString()
	.replace(/[-:]/g, '')
	.replace(/\.\d{3}Z$/, 'Z');

const sendCalendarInvite = async (client, sender, recipient, domain) => {
	const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
	const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
	const subject = `Snappy audit calendar fixture ${domain} ${runId}`;
	const filename = `snappy-audit-${domain}.ics`;
	const boundary = `snappymail-audit-${runId}-${Math.random().toString(16).slice(2)}`;
	const calendarData = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//SnappyMail Audit//EN',
		'METHOD:REQUEST',
		'BEGIN:VEVENT',
		`UID:snappymail-audit-${domain}-${runId}@audit.local`,
		`DTSTAMP:${iCalendarTimestamp(new Date())}`,
		`DTSTART:${iCalendarTimestamp(startsAt)}`,
		`DTEND:${iCalendarTimestamp(endsAt)}`,
		`SUMMARY:SnappyMail audit invitation ${domain}`,
		'DESCRIPTION:Fixture used only to audit calendar-invite handling.',
		`ORGANIZER:mailto:${sender}`,
		`ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:${recipient}`,
		'END:VEVENT',
		'END:VCALENDAR',
		''
	].join('\r\n');
	const message = [
		`From: <${sender}>`,
		`To: <${recipient}>`,
		`Subject: ${subject}`,
		`Message-ID: <${runId}-${Math.random().toString(16).slice(2)}@audit.local>`,
		`X-Snappy-Audit-Run: ${runId}`,
		'MIME-Version: 1.0',
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		'',
		`--${boundary}`,
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Calendar invitation fixture. Opening this mail must not add an event automatically.',
		`--${boundary}`,
		`Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="${filename}"`,
		`Content-Disposition: attachment; filename="${filename}"`,
		'Content-Transfer-Encoding: 8bit',
		'',
		calendarData,
		`--${boundary}--`
	].join('\r\n');
	await deliverMessage(client, sender, recipient, message);
};

const seedDomain = async (env, domain) => {
	const prefix = 'boompay.ca' === domain ? 'BOOMPAY' : 'NIXC';
	const sender = env[`SNAPPYMAIL_AUDIT_${prefix}_A_EMAIL`];
	const password = env[`SNAPPYMAIL_AUDIT_${prefix}_A_PASSWORD`];
	const recipient = env[`SNAPPYMAIL_AUDIT_${prefix}_B_EMAIL`];
	if (!sender || !password || !recipient) {
		throw new Error(`Missing audit credentials for ${domain}.`);
	}

	const client = await connectSmtp();
	try {
		expectCode(await client.read(), [220], 'greeting');
		await readCommand(client, 'EHLO snappymail-audit', [250], 'EHLO');
		const auth = Buffer.from(`\u0000${sender}\u0000${password}`).toString('base64');
		await readCommand(client, `AUTH PLAIN ${auth}`, [235], 'AUTH');
		for (let index = 1; index <= count; index += 1) {
			const suffix = String(index).padStart(2, '0');
			await sendMessage(
				client,
				sender,
				recipient,
				`Snappy audit fixture ${domain} ${runId} action-${suffix}`,
				`Seeded audit message ${suffix} for the ${domain} bulk-selection scenario.`
			);
		}
		if (calendar) {
			await sendCalendarInvite(client, sender, recipient, domain);
		}
		await readCommand(client, 'QUIT', [221], 'QUIT');
	} finally {
		client.socket.end();
	}
};

const main = async () => {
	const env = parseEnvFile(envFile);
	const domains = requestedDomain ? [requestedDomain] : ['boompay.ca', 'nixc.us'];
	for (const domain of domains) {
		if (!['boompay.ca', 'nixc.us'].includes(domain)) {
			throw new Error(`Unsupported audit domain: ${domain}`);
		}
		await seedDomain(env, domain);
	}
	console.log(JSON.stringify({ runId, count, calendar, domains }, null, 2));
};

main().catch(error => {
	console.error(error.message);
	process.exitCode = 1;
});
