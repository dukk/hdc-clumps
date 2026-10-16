<?php
/**
 * Apply FreePBX admin password, NAT/RTP, Twilio PJSIP trunk, and outbound route.
 * Reads JSON from /tmp/hdc-freepbx-apply.json (mode 0600). Does not print secrets.
 */
$bootstrap_settings['freepbx_auth'] = false;
if (!include '/etc/freepbx.conf') {
    fwrite(STDERR, "freepbx.conf missing — install FreePBX first\n");
    exit(1);
}

$payloadPath = '/tmp/hdc-freepbx-apply.json';
$raw = file_get_contents($payloadPath);
$payload = json_decode($raw === false ? '' : $raw, true);
if (!is_array($payload)) {
    fwrite(STDERR, "apply payload is not JSON\n");
    exit(1);
}

$adminUser = isset($payload['admin_user']) ? (string) $payload['admin_user'] : 'admin';
$adminPass = isset($payload['admin_password']) ? (string) $payload['admin_password'] : '';
if ($adminPass === '') {
    fwrite(STDERR, "admin_password missing from payload\n");
    exit(1);
}

$um = \FreePBX::Userman();
$user = $um->getUserByUsername($adminUser);
if (!is_array($user) || empty($user['id'])) {
    $created = $um->addUser($adminUser, $adminPass, 'all', 'HDC FreePBX admin');
    $uid = is_array($created) ? ($created['id'] ?? null) : $created;
    if ($uid === null || $uid === '' || $uid === false) {
        fwrite(STDERR, "failed to create FreePBX user {$adminUser}\n");
        exit(1);
    }
    fwrite(STDERR, "created FreePBX user {$adminUser} id {$uid}\n");
} else {
    $uid = $user['id'];
    $description = isset($user['description']) ? (string) $user['description'] : 'HDC FreePBX admin';
    $um->updateUser($uid, $adminUser, $adminUser, 'all', $description, array(), $adminPass);
    fwrite(STDERR, "admin password updated for {$adminUser}\n");
}
$um->setGlobalSettingByID($uid, 'pbx_login', true);
$um->setGlobalSettingByID($uid, 'pbx_modules', array('*'));
$um->setGlobalSettingByID($uid, 'pbx_low', '');
$um->setGlobalSettingByID($uid, 'pbx_high', '');

$ss = \FreePBX::Sipsettings();
$ss->setConfig('rtpstart', (string) $payload['rtp_port_min']);
$ss->setConfig('rtpend', (string) $payload['rtp_port_max']);
if (!empty($payload['externip'])) {
    $ss->setConfig('externip', (string) $payload['externip']);
}
if (!empty($payload['local_net']) && strpos((string) $payload['local_net'], '/') !== false) {
    list($net, $mask) = explode('/', (string) $payload['local_net'], 2);
    $ss->setConfig('localnets', array(array('net' => $net, 'mask' => $mask)));
}
fwrite(STDERR, "sip settings rtp {$payload['rtp_port_min']}-{$payload['rtp_port_max']}\n");

$trunkId = null;
if (!empty($payload['twilio_enabled']) && is_array($payload['pjsip'])) {
    $core = \FreePBX::Core();
    $name = (string) $payload['trunk_name'];
    foreach ($core->listTrunks() as $trunk) {
        if (isset($trunk['name']) && $trunk['name'] === $name) {
            $tech = isset($trunk['tech']) ? $trunk['tech'] : 'pjsip';
            $core->deleteTrunk($trunk['trunkid'], $tech);
            fwrite(STDERR, "removed existing trunk {$name}\n");
        }
    }
    $settings = $payload['pjsip'];
    $settings['channelid'] = $name;
    $settings['disabletrunk'] = 'off';
    $settings['keepcid'] = 'off';
    $settings['outcid'] = '';
    $settings['dialoutprefix'] = '';
    $settings['maxchans'] = '';
    $settings['failtrunk'] = '';
    $settings['continue'] = 'off';
    $trunkId = $core->addTrunk($name, 'pjsip', $settings);
    fwrite(STDERR, "trunk {$name} id {$trunkId}\n");

    $routeName = (string) $payload['route_name'];
    $prefix = (string) $payload['dial_prefix'];
    $routing = new \FreePBX\modules\Core\Components\Outboundrouting(\FreePBX::Database());
    foreach ($routing->listAll() as $route) {
        if (isset($route['name']) && $route['name'] === $routeName) {
            $routing->deleteById($route['route_id']);
            fwrite(STDERR, "removed existing route {$routeName}\n");
        }
    }
    $patterns = array(
        array(
            'match_pattern_prefix' => $prefix,
            'match_pattern_pass' => '+X.',
            'match_cid' => '',
            'prepend_digits' => '',
        ),
        array(
            'match_pattern_prefix' => $prefix,
            'match_pattern_pass' => 'X.',
            'match_cid' => '',
            'prepend_digits' => '',
        ),
    );
    $routeId = $routing->add(
        $routeName,
        '',
        '',
        '',
        '',
        '',
        'default',
        '',
        $patterns,
        array($trunkId),
        'new',
        ''
    );
    fwrite(STDERR, "outbound route {$routeName} id {$routeId} prefix {$prefix}\n");
}

if (function_exists('needreload')) {
    needreload();
}
fwrite(STDERR, "apply ok\n");
exit(0);
