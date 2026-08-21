const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const test = path.join(root, 'tests/php/wkd-discovery.php');
const php = process.env.PHP_BINARY || 'php';

const run = (command, args, options = {}) => childProcess.spawnSync(command, args, {
	cwd: root,
	encoding: 'utf8',
	...options
});
const print = result => {
	process.stdout.write(result.stdout || '');
	process.stderr.write(result.stderr || '');
};

let result = run(php, [test]);
if (result.error?.code === 'ENOENT') {
	const container = run('docker', ['compose', 'ps', '-q', 'snappymail']);
	if (container.error || !container.stdout.trim()) {
		throw Error('OpenPGP WKD tests need PHP CLI or a running `docker compose` snappymail service.');
	}
	result = run('docker', [
		'compose', 'exec', '-T',
		'-e', 'SNAPPYMAIL_SOURCE_ROOT=/snappymail/snappymail',
		'snappymail', 'php'
	], { input: fs.readFileSync(test, 'utf8') });
}
print(result);
if (result.error) {
	throw result.error;
}
if (0 !== result.status) {
	process.exitCode = result.status || 1;
}
