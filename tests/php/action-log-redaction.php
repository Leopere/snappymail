<?php

declare(strict_types=1);

$sourceRoot = \getenv('SNAPPYMAIL_SOURCE_ROOT') ?: \dirname(__DIR__, 2) . '/snappymail';
require $sourceRoot . '/v/0.0.0/app/libraries/RainLoop/ServiceActions.php';

$method = new \ReflectionMethod(\RainLoop\ServiceActions::class, 'redactActionLogParams');
$method->setAccessible(true);

$secrets = [];
$input = [
	'Action' => 'AdminPluginSettingsUpdate',
	'XToken' => 'csrf-secret',
	'id' => 'rocksign',
	'settings' => [
		'api_token' => 'rocksign-secret',
		'client-secret' => 'oauth-secret',
		'rocksignApiKey' => 'api-key-secret',
		'authorization_header' => 'Bearer secret',
		'nested' => [
			['Password' => 'mail-password', 'display_name' => 'Visible'],
			['credentials' => ['credential-one', 'credential-two']]
		],
		'public_key' => 'public-key-data'
	],
	'metadata' => [
		'template_id' => 'template-1',
		'external_id' => 'external-1'
	]
];

$actual = $method->invoke(null, $input, static function (string $secret) use (&$secrets) : void {
	$secrets[] = $secret;
});

$assert = static function (bool $condition, string $message) : void {
	if (!$condition) {
		throw new \RuntimeException($message);
	}
};

$assert('*******' === $actual['XToken'], 'The CSRF token must be redacted.');
$assert('*******' === $actual['settings']['api_token'], 'Nested API tokens must be redacted.');
$assert('*******' === $actual['settings']['client-secret'], 'Nested secrets must be redacted.');
$assert('*******' === $actual['settings']['rocksignApiKey'], 'API key spelling variants must be redacted.');
$assert('*******' === $actual['settings']['authorization_header'], 'Authorization fields must be redacted.');
$assert('*******' === $actual['settings']['nested'][0]['Password'], 'Deep passwords must be redacted.');
$assert('*******' === $actual['settings']['nested'][1]['credentials'], 'Sensitive arrays must be redacted as one field.');
$assert('Visible' === $actual['settings']['nested'][0]['display_name'], 'Non-sensitive nested fields must remain visible.');
$assert('public-key-data' === $actual['settings']['public_key'], 'Public keys must not be treated as credentials.');
$assert('template-1' === $actual['metadata']['template_id'], 'Non-sensitive metadata must remain visible.');

foreach (['csrf-secret', 'rocksign-secret', 'oauth-secret', 'api-key-secret', 'Bearer secret', 'mail-password', 'credential-one', 'credential-two'] as $secret) {
	$assert(\in_array($secret, $secrets, true), "The logger masker did not receive {$secret}.");
}
$assert(!\in_array('Visible', $secrets, true), 'Non-sensitive values must not be registered as logger secrets.');
$assert('rocksign-secret' === $input['settings']['api_token'], 'Redaction must not mutate action parameters.');

$rockSignSecrets = [];
$rockSignInput = [
	'Action' => 'PluginRockSignCreateSubmission',
	'XToken' => 'another-csrf-token',
	'template_id' => '42',
	'delivery' => 'rocksign',
	'subject' => 'Private acquisition agreement',
	'body' => 'Please review the confidential terms.',
	'submitters' => '[{"role":"Buyer","email":"signer@example.test","name":"Private Signer"}]'
];
$rockSignActual = $method->invoke(null, $rockSignInput, static function (string $secret) use (&$rockSignSecrets) : void {
	$rockSignSecrets[] = $secret;
}, 'DoPluginRockSignCreateSubmission');
$assert('42' === $rockSignActual['template_id'], 'Non-private RockSign routing metadata may remain visible.');
$assert('rocksign' === $rockSignActual['delivery'], 'The RockSign delivery mode may remain visible.');
foreach (['subject', 'body', 'submitters'] as $key) {
	$assert('*******' === $rockSignActual[$key], "RockSign {$key} must be redacted from action logs.");
}
$encodedLog = \json_encode($rockSignActual);
foreach (['Private acquisition agreement', 'confidential terms', 'signer@example.test', 'Private Signer'] as $private) {
	$assert(!\str_contains($encodedLog, $private), "RockSign action logs exposed {$private}.");
}
$assert(\in_array('Private acquisition agreement', $rockSignSecrets, true),
	'RockSign invitation copy must be registered with the logger masker.');
$assert(\in_array($rockSignInput['submitters'], $rockSignSecrets, true),
	'RockSign signer JSON must be registered with the logger masker.');

$messageSecrets = [];
$privateSigningUrl = 'https://sign.boompay.ca/s/123456789ABCDE';
$messageInput = [
	'Action' => 'SendMessage',
	'XToken' => 'send-csrf-token',
	'identityID' => '1',
	'saveFolder' => 'Sent',
	'to' => 'signer@example.test',
	'subject' => 'Private contract invitation',
	'plain' => "Review and sign: {$privateSigningUrl}",
	'attachments' => ['temp-contract' => ['name' => 'private-contract.pdf']]
];
$messageActual = $method->invoke(null, $messageInput, static function (string $secret) use (&$messageSecrets) : void {
	$messageSecrets[] = $secret;
}, 'DoSendMessage');
$assert('1' === $messageActual['identityID'] && 'Sent' === $messageActual['saveFolder'],
	'Non-private send routing metadata may remain visible.');
foreach (['to', 'subject', 'plain', 'attachments'] as $key) {
	$assert('*******' === $messageActual[$key], "SendMessage {$key} must be redacted from action logs.");
}
$messageLog = \json_encode($messageActual);
$assert(!\str_contains($messageLog, $privateSigningUrl),
	'The private RockSign signer URL must not reappear in a later SendMessage action log.');
$assert(\in_array("Review and sign: {$privateSigningUrl}", $messageSecrets, true),
	'The outgoing message body must be registered with the logger masker.');

echo "Action log redaction tests passed\n";
