const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { assets } = require('../../scripts/fetch-email-classifier-assets.cjs');

assert.strictEqual(assets.length, 6, 'classifier asset manifest must stay intentionally small');
for (const asset of assets) {
	assert.match(asset.url, /^https:\/\//, `asset URL must use HTTPS: ${asset.path}`);
	assert.match(asset.sha256, /^[a-f0-9]{64}$/, `asset needs a pinned SHA-256: ${asset.path}`);
	assert.ok(0 < asset.bytes, `asset needs an expected byte size: ${asset.path}`);
}

const worker = read('vendors/email-classifier/email-classifier-v1.worker.js');
assert.match(worker, /import\('\.\/runtime\/transformers\.min\.js'\)/,
	'classifier runtime must load lazily from the same-origin worker directory');
assert.match(worker, /allowRemoteModels\s*=\s*false/,
	'browser model downloads must remain disabled');
assert.match(worker, /allowLocalModels\s*=\s*true/);
assert.match(worker, /local_files_only:\s*true/);
assert.match(worker, /quantized:\s*true/);
assert.match(worker, /numThreads\s*=\s*1/,
	'WASM inference must work without cross-origin isolation on Safari and Android');
assert.doesNotMatch(worker, /https?:\/\//,
	'the browser worker must not contain any third-party endpoint');
assert.doesNotMatch(worker, /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/,
	'the browser worker must not transmit message content');
assert.ok(worker.length < 16000, 'classifier orchestration should remain small and reviewable');

const vendors = read('tasks/vendors.js');
assert.match(vendors, /ensureClassifierAssets/);
assert.match(vendors, /encoding:\s*false/g,
	'binary classifier files must be copied without text decoding');
assert.match(vendors, /static\/classifier-v1/);
for (const license of [
	'vendors/email-classifier/licenses/Apache-2.0.txt',
	'vendors/email-classifier/licenses/MIT-ONNX-Runtime.txt',
	'vendors/email-classifier/licenses/MIT-Hugging-Face-Jinja.txt'
]) {
	assert.ok(read(license).length > 500, `redistributed license text is missing: ${license}`);
}

const csp = read('snappymail/v/0.0.0/app/libraries/snappymail/http/csp.php');
assert.match(csp, /'worker-src'\s*=>\s*\["'self'"\]/);
assert.match(csp, /'wasm-unsafe-eval'/);

const nginx = read('.docker/release/files/etc/nginx/nginx.conf');
assert.match(nginx, /static\/classifier-v\[0-9\]\+/);
assert.match(nginx, /application\/wasm wasm/);
assert.match(nginx, /max-age=31536000, immutable/);

const manager = read('dev/Classifier/EmailClassifier.js');
assert.match(manager, /classifier-v1\/email-classifier-v1\.worker\.js/);
assert.match(manager, /strict:\s*1/,
	'manual categories must surface servers that cannot persist IMAP keywords');
assert.match(manager, /DISPLAY_CONFIDENCE_THRESHOLD\s*=\s*0\.68/);
assert.match(manager, /MODEL_PERSIST_CONFIDENCE_THRESHOLD\s*=\s*0\.82/,
	'only high-confidence semantic results may become durable');
assert.match(manager, /AUTOMATIC_CATEGORY_FLAG/,
	'automatic categories need distinct provenance from user corrections');
assert.match(manager, /retentionKeyword\(retentionPolicy\)/,
	'only deterministic rule results may select a durable retention keyword');
assert.match(manager, /writeMessageCategory\(message, result\.category, true, result\.retentionPolicy\)/,
	'automatic persistence must store category and retention signals together');
assert.match(manager, /BEGIN PGP MESSAGE/,
	'encrypted armor must be excluded from semantic classification');
assert.match(manager, /resultCache\[item\.cacheKey\]\s*=\s*\[/,
	'only fixed classification metadata should be cached');
assert.doesNotMatch(manager, /resultCache\[[^\]]+\]\s*=\s*[^\n]*(?:text|subject|preview|body)/,
	'cached classifier entries must not retain message text');
const identityBlock = manager.slice(
	manager.indexOf('classifierIdentity ='),
	manager.indexOf('applyClassification =')
);
assert.match(identityBlock, /SettingsGet\('accountHash'\)/,
	'cache identity must be account-scoped');
assert.match(identityBlock, /message\.folder/);
assert.match(identityBlock, /message\.uid/);
assert.doesNotMatch(identityBlock, /\b(?:text|subject|preview|body|fingerprint)\b/,
	'cache identity must not derive from private message text');
assert.match(manager, /confidence\s*>=\s*0/,
	'negative model outcomes should be cached to avoid repeated mobile inference');
assert.match(manager, /MAX_PENDING_ITEMS\s*=\s*256/,
	'worker queues must be bounded');
assert.match(manager, /setTimeout\(disableWorker, WORKER_TIMEOUT\)/,
	'a stalled local model must release queued messages');
assert.match(manager, /confidence\s*<\s*currentConfidence/,
	'a weaker semantic result must not erase a stronger rule result');
assert.match(manager, /else if \(hintApplied\) \{\s*persistAutomaticCategory\(message, hint\)/,
	'rejected synchronous rule results must not become durable');
assert.match(manager, /getFolderFromCacheList\(message\.folder\)\?\.tagsAllowed\(\)/,
	'programmatic correction calls must enforce writable IMAP keywords');
assert.match(manager, /for \(const flag of addedFlags\)[\s\S]*requestKeyword\(message, flag, false\)/,
	'partially added category metadata must be compensated on failure');
assert.match(manager, /message\.folder !== getFolderInboxName\(\)/,
	'category routing must never move messages out of arbitrary folders');
assert.match(manager, /target\.isSystemFolder\(\)/,
	'category routing must reject unsafe system-folder destinations');
const automaticPersistence = manager.match(/persistAutomaticCategory = \(message, result\) => \{[\s\S]*?\n\t\};/)?.[0] || '';
assert.doesNotMatch(automaticPersistence, /routeMessageCategory/,
	'automatic suggestions must never move messages');
assert.match(manager, /const saved = await writeMessageCategory\(message, category\);[\s\S]*await routeMessageCategory/,
	'an explicit category choice may move only after its durable correction is saved');

const folder = read('dev/Stores/User/Folder.js');
assert.match(folder, /!value\.startsWith\('\$smcat-'\)/,
	'reserved correction keywords must stay out of normal tags');
assert.match(folder, /!value\.startsWith\('\$smret-'\)/,
	'reserved retention keywords must stay out of normal tags');

const messageModel = read('dev/Model/Message.js');
assert.match(messageModel, /automaticCategoryStored:[\s\S]*manualCategory:/,
	'automatic provenance must not masquerade as a manual correction');

const categoryModule = read('dev/Classifier/Categories.js');
assert.match(categoryModule, /SMART_CATEGORY_VALUES = Object\.freeze/);
assert.match(categoryModule, /parseCategoryFolderRoutes/);
assert.match(categoryModule, /'auth-code-1d': '\$smret-auth-code'/);
assert.match(categoryModule, /'security-alert-30d': '\$smret-security-alert'/);

const folderList = read('dev/View/User/MailBox/FolderList.js'),
	folderTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/MailFolderList.html');
assert.doesNotMatch(folderList, /categoryViews|openCategory/,
	'the sidebar must not duplicate real Smart folders with virtual category links');
assert.doesNotMatch(folderTemplate, /b-folders-categories|foreach: categoryViews/,
	'the sidebar must expose one Smart hierarchy rather than a second category taxonomy');

const folderSettings = read('dev/Settings/User/Folders.js'),
	folderSettingsTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/SettingsFolders.html');
assert.match(folderSettings, /Remote\.saveSetting\('CategoryFolderRoutes'/,
	'folder mappings must persist across browsers');
assert.match(folderSettingsTemplate, /foreach: categoryRoutes/);
assert.match(folderSettingsTemplate, /autoConfigureCategoryFolders/,
	'users need an explicit way to repair or restore automatic setup');
assert.match(folderSettingsTemplate, /optionsAfterRender: \$root\.defaultOptionsAfterRender/,
	'system folders marked unsafe by the option builder must actually be disabled');

const categoryFolderSetup = read('dev/Classifier/CategoryFolders.js'),
	userApp = read('dev/App/User.js');
assert.match(categoryFolderSetup, /Remote\.post\('FolderCreate'/,
	'missing category folders must be created without a settings visit');
assert.match(categoryFolderSetup, /discoverRoutes\(/,
	'existing suitable folders must be reused before creating duplicates');
assert.match(categoryFolderSetup, /nextFolderName\('Categories'/,
	'new category destinations should be grouped to avoid six noisy top-level folders');
assert.match(categoryFolderSetup, /new Set\(force \|\| !storedValue/,
	'an explicit saved mapping, including {}, must disable first-run setup');
assert.match(categoryFolderSetup, /storedRoutes\[option\.value\][\s\S]*!isRouteTarget/,
	'deleted or unsafe saved destinations must repair without reviving opted-out categories');
assert.doesNotMatch(userApp, /setupCategoryFolders\(/,
	'category move destinations must not be created automatically at login');

const accountSettings = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Accounts.php'),
	userSettings = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/User.php');
assert.match(accountSettings, /'CategoryFolderRoutes' => ''/,
	'an absent setting must leave optional category moves disabled');
assert.match(accountSettings, /GetConf\(\s*'CategoryFolderRoutes'/);
assert.match(userSettings, /setSettingsFromParams\(\$oSettingsLocal, 'CategoryFolderRoutes'/);

const searchParser = read('snappymail/v/0.0.0/app/libraries/MailSo/Imap/SearchCriterias.php');
assert.match(searchParser, /case 'KEYWORD':/,
	'smart category links require server-side keyword search support');

const listTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/MailMessageList.html');
assert.strictEqual((listTemplate.match(/class="messageCategoryBadge"/g) || []).length, 2,
	'grouped and ungrouped message rows each need one category badge');
const messageTemplate = read('snappymail/v/0.0.0/app/templates/Views/User/MailMessageView.html');
assert.strictEqual((messageTemplate.match(/class="messageCategoryPicker"/g) || []).length, 1,
	'the opened message needs one correction control');
assert.match(messageTemplate, /enable:\s*(?:\$root\.)?messageCategoryWritable/,
	'the correction control must be disabled when its folder cannot persist custom keywords');

const messageActions = read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Messages.php');
assert.match(messageActions, /GetActionParam\('strict', '0'\)/,
	'strict keyword writes must not silently succeed when the server rejects custom flags');

console.log('Local email classifier asset and privacy contracts passed');
