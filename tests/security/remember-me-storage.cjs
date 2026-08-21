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
assert.match(
	putMethod,
	/catch \(\\RuntimeException \$e\)/,
	'FileStorage must not suppress programmer errors or invalid storage types.'
);

const utils = read('snappymail/v/0.0.0/app/libraries/RainLoop/Utils.php');
const saveFile = utils.match(/public static function saveFile\([\s\S]*?\n\t}/)?.[0] || '';
assert.match(
	saveFile,
	/if \(!\\chmod\(\$filename, 0600\)\)[\s\S]*throw new \\RuntimeException/,
	'Remember-me token files must fail closed when mode 0600 cannot be applied.'
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
