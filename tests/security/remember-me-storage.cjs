const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const fileStorage = read('snappymail/v/0.0.0/app/libraries/RainLoop/Providers/Storage/FileStorage.php');
const userAuth = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/UserAuth.php');

const putMethod = fileStorage.match(/public function Put\([\s\S]*?\n\t}/)?.[0] || '';
assert.match(
	putMethod,
	/try\s*{[\s\S]*generateFileName\([^;]+true\)/,
	'FileStorage must catch directory-creation failures during writes.'
);

const signMeMethod = userAuth.match(/public function SetSignMeToken\([\s\S]*?\n\t}/)?.[0] || '';
const storageWrite = signMeMethod.indexOf('StorageProvider()->Put(');
const cookieWrite = signMeMethod.indexOf('Cookies::set(');
assert(storageWrite >= 0, 'Remember-me must persist a server-side token.');
assert(cookieWrite > storageWrite, 'Remember-me must persist its server token before issuing the cookie.');
assert.match(
	signMeMethod,
	/if \(!\$this->StorageProvider\(\)->Put\([\s\S]*?\)\)\s*{[\s\S]*?return;/,
	'A failed remember-me storage write must degrade to a normal session login.'
);

console.log('Remember-me storage regression tests passed');
