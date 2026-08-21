#!/usr/bin/env node

import fs from 'node:fs';

const REQUIRE_BEGIN = '# BEGIN SNAPPYMAIL MANAGED SORTING REQUIREMENTS';
const REQUIRE_END = '# END SNAPPYMAIL MANAGED SORTING REQUIREMENTS';
const RULE_BEGIN = '# BEGIN SNAPPYMAIL MANAGED NEWSLETTER SORTING';
const RULE_END = '# END SNAPPYMAIL MANAGED NEWSLETTER SORTING';

const excludedSubjects = Object.freeze([
	'calendar invite',
	'calendar invitation',
	'meeting invite',
	'meeting invitation',
	'event invite',
	'event invitation',
	'rsvp',
	'response requested',
	'signature requested',
	'signature needed',
	'please sign',
	'awaiting your signature',
	'ready for your signature',
	'review and sign',
	'review & sign',
	'contract',
	'agreement',
	'lease',
	'waiver',
	'nda',
	'invoice',
	'receipt',
	'payment',
	'amount due',
	'billing',
	'account statement',
	'remittance',
	'purchase order',
	'refund',
	'tax document',
	'tax form',
	'payroll',
	'security alert',
	'unusual sign-in',
	'unusual signin',
	'unusual login',
	'unusual activity',
	'new sign-in',
	'new signin',
	'new login',
	'password reset',
	'password changed',
	'password expires',
	'two-factor',
	'2fa',
	'one-time code',
	'one-time password',
	'verification code',
	'verify your account',
	'verify your email',
	'verify your identity',
	'account locked',
	'suspicious activity',
	'action required',
	'response required',
	'approval required',
	'please review',
	'please approve',
	'please confirm',
	'please verify',
	'please respond'
]);

const usage = () => {
	console.error('Usage: newsletter-sieve.mjs render <folder> | patch <folder> | remove');
	process.exitCode = 2;
};

const safeFolder = value => {
	if (!value || value.length > 512 || /[\x00-\x1f\x7f]/u.test(value)) {
		throw new Error('Folder must be 1-512 characters without control characters');
	}
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
};

const removeBlock = (source, begin, end) => {
	let start;
	while (-1 !== (start = source.indexOf(begin))) {
		const finish = source.indexOf(end, start + begin.length);
		if (-1 === finish) {
			throw new Error(`Managed marker "${begin}" has no closing marker`);
		}
		let after = finish + end.length;
		if ('\r' === source[after]) {
			after++;
		}
		if ('\n' === source[after]) {
			after++;
		}
		source = source.slice(0, start) + source.slice(after);
	}
	return source;
};

const removeManaged = source => removeBlock(
	removeBlock(source, REQUIRE_BEGIN, REQUIRE_END),
	RULE_BEGIN,
	RULE_END
).replace(/^\s+|\s+$/g, '');

const blocks = (folder, eol) => {
	const requirements = [
		REQUIRE_BEGIN,
		'require ["fileinto"];',
		REQUIRE_END
	].join(eol);
	const subjects = excludedSubjects
		.map((subject, index) => `\t\t"${subject.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"${index + 1 < excludedSubjects.length ? ',' : ''}`)
		.join(eol);
	const rule = [
		RULE_BEGIN,
		'if allof(',
		'\tanyof(',
		'\t\texists "List-Id",',
		'\t\texists "List-Unsubscribe"',
		'\t),',
		'\tnot header :contains ["Subject"] [',
		subjects,
		'\t]',
		')',
		'{',
		`\tfileinto "${safeFolder(folder)}";`,
		'\tstop;',
		'}',
		RULE_END
	].join(eol);
	return { requirements, rule };
};

const patch = (source, folder) => {
	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	const clean = removeManaged(source);
	const { requirements, rule } = blocks(folder, eol);
	return [requirements, clean, rule].filter(Boolean).join(eol + eol) + eol;
};

const [command, folder] = process.argv.slice(2);

try {
	if ('render' === command && folder) {
		process.stdout.write(patch('', folder));
	} else if ('patch' === command && folder) {
		process.stdout.write(patch(fs.readFileSync(0, 'utf8'), folder));
	} else if ('remove' === command && !folder) {
		const source = fs.readFileSync(0, 'utf8');
		const eol = source.includes('\r\n') ? '\r\n' : '\n';
		const clean = removeManaged(source);
		process.stdout.write(clean ? clean + eol : '');
	} else {
		usage();
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
