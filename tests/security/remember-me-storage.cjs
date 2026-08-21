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

const loginProcess = userAuth.match(/public function LoginProcess\([\s\S]*?\n\t}/)?.[0] || '';
assert(loginProcess, 'UserAuth::LoginProcess method must be present.');
assert.match(
	loginProcess,
	/StorageType::SESSION/,
	'Login must persist session data under StorageType::SESSION.'
);
assert.match(
	loginProcess,
	/if\s*\(!\s*\$this->StorageProvider\(\)->Put\([\s\S]*?StorageType::SESSION[\s\S]*?\)\s*\)/,
	'LoginProcess must check boolean StorageProvider()->Put result for session writes.'
);
const authTokenWrite = loginProcess.indexOf('SetAuthToken(');
const sessionWrite = loginProcess.indexOf('StorageType::SESSION');
assert(authTokenWrite > 0, 'LoginProcess should set auth token when session is persisted.');
assert(authTokenWrite > sessionWrite, 'Auth token cookie write must happen after session persistence succeeds.');
assert.match(
	loginProcess,
	/if\s*\(!\$this->StorageProvider\(\)->Put\([\s\S]*?StorageType::SESSION[\s\S]*?\)\)\s*{[\s\S]*?Cookies::clear\(Utils::SESSION_TOKEN\);[\s\S]*?Cookies::clear\(self::AUTH_SPEC_TOKEN_KEY\);[\s\S]*?Cookies::clear\(self::AUTH_ADDITIONAL_TOKEN_KEY\);[\s\S]*?throw new ClientException\(/,
	'LoginProcess must clear all session/auth cookies and abort when mandatory persistence fails.'
);

const restoreSession = userAuth.match(/public function getMainAccountFromToken\([\s\S]*?\n\t}/)?.[0] || '';
assert.match(
	restoreSession,
	/if\s*\(!\$this->StorageProvider\(\)->Put\([\s\S]*?StorageType::SESSION[\s\S]*?\)\)\s*{[\s\S]*?Cookies::clear\(Utils::SESSION_TOKEN\);[\s\S]*?Cookies::clear\(self::AUTH_SPEC_TOKEN_KEY\);[\s\S]*?Cookies::clear\(self::AUTH_ADDITIONAL_TOKEN_KEY\);[\s\S]*?throw new ClientException\(/,
	'Remember-me restoration must not issue auth cookies unless its mandatory session write succeeds.'
);

console.log('Remember-me storage regression tests passed');
