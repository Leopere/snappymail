const { execFileSync } = require('child_process');
const { chromium } = require('@playwright/test');

const baseURL = process.env.SNAPPYMAIL_BASE_URL || 'http://127.0.0.1:8888';
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '';

const accounts = [
	{
		email: process.env.SNAPPYMAIL_TEST_EMAIL || 'test@example.com',
		password: process.env.SNAPPYMAIL_TEST_PASSWORD || 'MrcTest2026!'
	},
	{
		email: process.env.SNAPPYMAIL_SECONDARY_EMAIL || 'teammate@example.com',
		password: process.env.SNAPPYMAIL_SECONDARY_PASSWORD || process.env.SNAPPYMAIL_TEST_PASSWORD || 'MrcTest2026!'
	}
];

const sh = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

const run = (args, input) => execFileSync(args[0], args.slice(1), {
	cwd: process.cwd(),
	input,
	stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit'
});

const composeShell = (service, script, user) => {
	const args = ['docker', 'compose', 'exec', '-T'];
	user && args.push('-u', user);
	args.push(service, 'sh', '-lc', script);
	run(args);
};

const storagePart = email => {
	const [local, domain] = email.toLowerCase().split('@');
	return { local, domain };
};

const ensureMailbox = ({ email, password }) => composeShell(
	'docker-mailserver',
	`setup email list | grep -q ${sh(email)} || setup email add ${sh(email)} ${sh(password)}`
);

const seedIdentity = ({ email }) => {
	const { local, domain } = storagePart(email);
	composeShell('snappymail', `python3 - <<'PY'
import json
from pathlib import Path

email = ${emailJSON(email)}
path = Path('/var/lib/snappymail/_data_/_default_/storage') / ${emailJSON(domain)} / ${emailJSON(local)} / 'identities'
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps({
    '---': {
        'Id': '',
        'Label': '',
        'Email': email,
        'Name': '',
        'ReplyTo': '',
        'Bcc': '',
        'Signature': '',
        'SignatureInsertBefore': False,
        'sentFolder': '',
        'pgpEncrypt': False,
        'pgpSign': False,
        'smimeKey': '',
        'smimeCertificate': ''
    }
}, separators=(',', ':')))
PY
chown -R www-data:www-data ${sh(`/var/lib/snappymail/_data_/_default_/storage/${domain}/${local}`)}`);
};

const emailJSON = value => JSON.stringify(value);

const configureLocalDomains = () => {
	const domains = Array.from(new Set(accounts.map(account => storagePart(account.email).domain)));
	composeShell('snappymail', `python3 - <<'PY'
import json
from pathlib import Path

domains = ${JSON.stringify(domains)}
root = Path('/var/lib/snappymail/_data_/_default_')
domain_dir = root / 'domains'
domain_dir.mkdir(parents=True, exist_ok=True)

template = {
    'IMAP': {
        'host': 'imap.example.com',
        'port': 143,
        'type': 0,
        'timeout': 300,
        'shortLogin': False,
        'lowerLogin': True,
        'sasl': [
            'SCRAM-SHA3-512',
            'SCRAM-SHA-512',
            'SCRAM-SHA-256',
            'SCRAM-SHA-1',
            'PLAIN',
            'LOGIN'
        ],
        'ssl': {
            'verify_peer': False,
            'verify_peer_name': False,
            'allow_self_signed': False,
            'SNI_enabled': True,
            'disable_compression': True,
            'security_level': 1
        },
        'disabled_capabilities': [
            'METADATA',
            'OBJECTID',
            'PREVIEW',
            'STATUS=SIZE'
        ],
        'use_expunge_all_on_delete': False,
        'fast_simple_search': True,
        'force_select': False,
        'message_all_headers': False,
        'message_list_limit': 10000,
        'search_filter': ''
    },
    'SMTP': {
        'host': 'smtp.example.com',
        'port': 587,
        'type': 2,
        'timeout': 60,
        'shortLogin': False,
        'lowerLogin': True,
        'sasl': [
            'SCRAM-SHA3-512',
            'SCRAM-SHA-512',
            'SCRAM-SHA-256',
            'SCRAM-SHA-1',
            'PLAIN',
            'LOGIN'
        ],
        'ssl': {
            'verify_peer': False,
            'verify_peer_name': False,
            'allow_self_signed': False,
            'SNI_enabled': True,
            'disable_compression': True,
            'security_level': 1
        },
        'useAuth': True,
        'setSender': False,
        'usePhpMail': False
    },
    'Sieve': {
        'host': 'imap.example.com',
        'port': 4190,
        'type': 0,
        'timeout': 10,
        'shortLogin': False,
        'lowerLogin': True,
        'sasl': [
            'SCRAM-SHA3-512',
            'SCRAM-SHA-512',
            'SCRAM-SHA-256',
            'SCRAM-SHA-1',
            'PLAIN',
            'LOGIN'
        ],
        'ssl': {
            'verify_peer': False,
            'verify_peer_name': False,
            'allow_self_signed': False,
            'SNI_enabled': True,
            'disable_compression': True,
            'security_level': 1
        },
        'enabled': False
    },
    'whiteList': ''
}

for domain in domains:
    (domain_dir / f'{domain}.json').write_text(json.dumps(template, indent=4) + '\\n')

disabled = domain_dir / 'disabled'
if disabled.exists():
    disabled_names = [line.strip() for line in disabled.read_text().replace(',', '\\n').splitlines()]
    disabled.write_text('\\n'.join(item for item in disabled_names if item and item not in domains))
PY
chown www-data:www-data ${domains.map(domain => sh(`/var/lib/snappymail/_data_/_default_/domains/${domain}.json`)).join(' ')}
rm -rf /var/lib/snappymail/_data_/_default_/cache/*`);
};

const login = async (browser, { email, password }) => {
	const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
	await page.goto('/');
	await page.locator('input[name=Email]').fill(email);
	await page.locator('input[name=Password]').fill(password);
	await page.locator('.buttonLogin').click();
	await page.waitForFunction(() => window.rl?.settings?.get?.('Auth') === true, null, { timeout: 60000 });
	await page.waitForSelector('#rl-content:not([hidden])', { timeout: 30000 });
	await page.waitForTimeout(5000);
	await page.close();
};

const exchangePublicKeys = () => {
	const [first, second] = accounts.map(account => {
		const part = storagePart(account.email);
		return {
			...account,
			...part,
			gnupg: `/var/lib/snappymail/_data_/_default_/storage/${part.domain}/${part.local}/.gnupg`
		};
	});

	composeShell('snappymail', `chown -R www-data:www-data ${sh(first.gnupg)} ${sh(second.gnupg)}`);
	composeShell('snappymail', `
set -eu
tmp=/tmp/snappymail-local-public-keys
rm -rf "$tmp"
mkdir -p "$tmp"
GNUPGHOME=${sh(first.gnupg)} gpg --batch --yes --armor --export ${sh(first.email)} > "$tmp/first.asc"
GNUPGHOME=${sh(second.gnupg)} gpg --batch --yes --armor --export ${sh(second.email)} > "$tmp/second.asc"
GNUPGHOME=${sh(first.gnupg)} gpg --batch --yes --import "$tmp/second.asc"
GNUPGHOME=${sh(second.gnupg)} gpg --batch --yes --import "$tmp/first.asc"
rm -rf "$tmp"
`, 'www-data');
};

(async () => {
	accounts.forEach(ensureMailbox);
	accounts.forEach(seedIdentity);
	configureLocalDomains();

	const browser = await chromium.launch(chromiumExecutable ? { executablePath: chromiumExecutable } : {});
	try {
		for (const account of accounts) {
			await login(browser, account);
		}
	} finally {
		await browser.close();
	}

	exchangePublicKeys();

	console.log(`Provisioned local internal GnuPG accounts:
- ${accounts[0].email}
- ${accounts[1].email}`);
})().catch(error => {
	console.error(error);
	process.exit(1);
});
