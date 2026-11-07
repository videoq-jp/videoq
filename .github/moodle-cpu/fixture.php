<?php
// CLI fixture for a disposable, source-pinned Moodle CPU acceptance site.
// No connection credentials, fake completed resources or AI outputs are seeded.
if (PHP_SAPI !== 'cli' || getenv('VIDEOQ_MOODLE_CPU_FIXTURE') !== '1') {
    throw new RuntimeException('Owned CLI acceptance fixture required');
}
$owner = getenv('VIDEOQ_MOODLE_CPU_OWNER');
$marker = '/var/www/moodledata/.videoq-cpu-owner';
if (!is_string($owner) || !preg_match('/^[a-f0-9]{32}$/D', $owner) ||
        !is_file($marker) || trim(file_get_contents($marker)) !== $owner) {
    throw new RuntimeException('Acceptance ownership mismatch');
}
// The official installer requires the same uid as Apache. Root-owned 0700
// cache/file directories would otherwise make the installed HTTP site unusable.
$apache = posix_getpwnam('www-data');
if (!$apache) {
    throw new RuntimeException('Missing Apache account');
}
if (posix_geteuid() === 0) {
    if (!posix_initgroups($apache['name'], $apache['gid']) ||
            !posix_setgid($apache['gid']) || !posix_setuid($apache['uid'])) {
        throw new RuntimeException('Cannot select Apache account');
    }
}
if (posix_geteuid() !== $apache['uid']) {
    throw new RuntimeException('Run fixture as the Apache account');
}
$action = $argv[1] ?? '';
$allowed = ['install', 'seed', 'status', 'network', 'tick', 'hide', 'show', 'suspend', 'resume',
    'deny-reports', 'allow-reports'];
if (!in_array($action, $allowed, true)) {
    throw new RuntimeException('Unknown acceptance action');
}
if ($action === 'install') {
    $password = getenv('MOODLE_FIXTURE_PASSWORD');
    if (!is_string($password) || strlen($password) < 20) {
        throw new RuntimeException('Missing disposable account password');
    }
    // Build arguments in memory, never expose the password in process arguments.
    $argv = [__FILE__, '--agree-license', '--lang=en', '--adminuser=admin',
        '--adminpass=' . $password, '--adminemail=cpu-admin@example.invalid',
        '--fullname=VideoQ CPU acceptance', '--shortname=VIDEOQ-CPU-ACCEPTANCE'];
    $argc = count($argv);
    $_SERVER['argv'] = $argv;
    $_SERVER['argc'] = $argc;
    require('/var/www/html/admin/cli/install_database.php');
    exit;
}
define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
if ($CFG->wwwroot !== 'https://moodle.localhost:18443' || $CFG->dbhost !== 'db' ||
        $CFG->dbname !== 'moodle' || $CFG->dbuser !== 'moodle' ||
        $SITE->shortname !== 'VIDEOQ-CPU-ACCEPTANCE' ||
        $DB->get_field_sql('SELECT current_user') !== 'moodle') {
    throw new RuntimeException('Disposable Moodle site identity mismatch');
}
$databaseowner = get_config('local_videoq', 'cpuacceptanceowner');
if ($databaseowner === false && $action === 'seed') {
    set_config('cpuacceptanceowner', $owner, 'local_videoq');
} else if ($databaseowner !== $owner) {
    throw new RuntimeException('Disposable database ownership mismatch');
}
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->dirroot . '/user/lib.php');
\core\session\manager::set_user(get_admin());
$prefix = 'cpu_' . substr($owner, 0, 12);
$shortname = strtoupper($prefix);
$course = $DB->get_record('course', ['shortname' => $shortname]);
if ($action === 'seed') {
    $password = getenv('MOODLE_FIXTURE_PASSWORD');
    $video = '/acceptance-input/video.mp4';
    $checksum = getenv('MOODLE_FIXTURE_VIDEO_SHA256');
    if (!is_string($password) || strlen($password) < 20 ||
            !is_string($checksum) || !preg_match('/^[a-f0-9]{64}$/D', $checksum) ||
            !is_file($video) || hash_file('sha256', $video) !== $checksum) {
        throw new RuntimeException('Public spoken fixture identity mismatch');
    }
    if (!$course) {
        $course = create_course((object)['fullname' => 'VideoQ spoken Japanese acceptance',
            'shortname' => $shortname, 'idnumber' => $owner, 'category' => 1, 'format' => 'topics']);
    }
    if ($course->idnumber !== $owner) {
        throw new RuntimeException('Course ownership mismatch');
    }
    $plugin = enrol_get_plugin('manual');
    $instances = array_filter(enrol_get_instances($course->id, true), fn($row) => $row->enrol === 'manual');
    if (!$instances) {
        $id = $plugin->add_default_instance($course);
        $instances = [$DB->get_record('enrol', ['id' => $id], '*', MUST_EXIST)];
    }
    $manual = reset($instances);
    // Disable the actual welcome-message producer for this owned course. The
    // global noemailever guard stays on as an independent last barrier.
    if ((int)$manual->customint1 !== ENROL_DO_NOT_SEND_EMAIL) {
        $plugin->update_instance($manual, (object)['customint1' => ENROL_DO_NOT_SEND_EMAIL]);
    }
    foreach (['teacher' => 'editingteacher', 'learner' => 'student', 'outsider' => null] as $name => $role) {
        $username = $prefix . '_' . $name;
        $user = $DB->get_record('user', ['username' => $username, 'deleted' => 0]);
        if (!$user) {
            $id = user_create_user((object)['username' => $username, 'idnumber' => $owner,
                'password' => $password, 'firstname' => ucfirst($name), 'lastname' => 'CPU fixture',
                'email' => $username . '@example.invalid', 'auth' => 'manual', 'confirmed' => 1,
                'mnethostid' => $CFG->mnet_localhost_id]);
            $user = $DB->get_record('user', ['id' => $id], '*', MUST_EXIST);
        }
        if ($user->idnumber !== $owner || $user->auth !== 'manual' || is_siteadmin($user)) {
            throw new RuntimeException('User ownership or authority mismatch');
        }
        if ($role !== null) {
            $roleid = $DB->get_field('role', 'id', ['shortname' => $role], MUST_EXIST);
            $plugin->enrol_user($manual, $user->id, $roleid);
        }
    }
    $resource = $DB->get_record('resource', ['course' => $course->id, 'name' => 'Public Japanese spoken lesson']);
    if (!$resource) {
        $module = add_moduleinfo((object)['modulename' => 'resource',
            'module' => $DB->get_field('modules', 'id', ['name' => 'resource'], MUST_EXIST),
            'course' => $course->id, 'section' => 0, 'visible' => 1, 'name' => 'Public Japanese spoken lesson',
            'intro' => 'Public FLEURS speech fixture for actual local ASR and cited questions.',
            'introformat' => FORMAT_HTML, 'display' => 0, 'printintro' => 0,
            'showsize' => 0, 'showtype' => 0, 'showdate' => 0, 'files' => 0], $course);
        $resource = $DB->get_record('resource', ['id' => $module->instance], '*', MUST_EXIST);
    }
    $cm = get_coursemodule_from_instance('resource', $resource->id, $course->id, false, MUST_EXIST);
    $context = context_module::instance($cm->id);
    $fs = get_file_storage();
    $file = $fs->get_file($context->id, 'mod_resource', 'content', 0, '/', 'spoken.mp4');
    if (!$file) {
        $file = $fs->create_file_from_pathname(['contextid' => $context->id, 'component' => 'mod_resource',
            'filearea' => 'content', 'itemid' => 0, 'filepath' => '/', 'filename' => 'spoken.mp4',
            'mimetype' => 'video/mp4', 'sortorder' => 1], $video);
    }
    if ($file->get_contenthash() !== sha1_file($video)) {
        throw new RuntimeException('Stored public fixture mismatch');
    }
    rebuild_course_cache($course->id, true);
}
if (!$course || $course->idnumber !== $owner) {
    throw new RuntimeException('Owned acceptance course missing');
}
$resource = $DB->get_record('resource', ['course' => $course->id, 'name' => 'Public Japanese spoken lesson'], '*', MUST_EXIST);
$cm = get_coursemodule_from_instance('resource', $resource->id, $course->id, false, MUST_EXIST);
$learner = $DB->get_record('user', ['username' => $prefix . '_learner', 'idnumber' => $owner], '*', MUST_EXIST);
if ($action === 'hide' || $action === 'show') {
    set_coursemodule_visible($cm->id, $action === 'show' ? 1 : 0);
    rebuild_course_cache($course->id, true);
}
if ($action === 'suspend' || $action === 'resume') {
    $manual = $DB->get_record('enrol', ['courseid' => $course->id, 'enrol' => 'manual'], '*', MUST_EXIST);
    enrol_get_plugin('manual')->update_user_enrol($manual, $learner->id,
        $action === 'suspend' ? ENROL_USER_SUSPENDED : ENROL_USER_ACTIVE);
}
if ($action === 'deny-reports' || $action === 'allow-reports') {
    $roleid = $DB->get_field('role', 'id', ['shortname' => 'editingteacher'], MUST_EXIST);
    $context = context_course::instance($course->id);
    if ($action === 'deny-reports') {
        assign_capability('local/videoq:viewreports', CAP_PROHIBIT, $roleid, $context->id, true);
    } else {
        unassign_capability('local/videoq:viewreports', $roleid, $context->id);
    }
}
$row = $DB->get_record('local_videoq_sync', ['cmid' => $cm->id]);
$network = null;
if ($action === 'network') {
    require_once($CFG->libdir . '/filelib.php');
    $curl = new curl();
    $curl->get($CFG->wwwroot . '/login/index.php', [], \local_videoq\client::http_options(15));
    $info = $curl->get_info();
    if ($curl->get_errno() || ($info['http_code'] ?? 0) !== 200 || ($info['ssl_verify_result'] ?? -1) !== 0) {
        fwrite(STDERR, 'VIDEOQ_CPU_NETWORK ' . json_encode(['stage' => 'private-https',
            'curlErrno' => (int)$curl->get_errno(), 'httpStatus' => (int)($info['http_code'] ?? 0),
            'tlsVerifyResult' => (int)($info['ssl_verify_result'] ?? -1)]) . "\n");
        throw new RuntimeException('Private Moodle HTTPS or peer certificate verification failed');
    }
    foreach (['tcp://1.1.1.1:443', 'tcp://[2606:4700:4700::1111]:443'] as $address) {
        // A TLS error would not prove that TCP egress was blocked.
        $socket = @stream_socket_client($address, $errorcode, $errortext, 3);
        if ($socket !== false) {
            fclose($socket);
            fwrite(STDERR, 'VIDEOQ_CPU_NETWORK ' . json_encode(['stage' => 'public-tcp']) . "\n");
            throw new RuntimeException('Public TCP egress was allowed');
        }
    }
    if (gethostbynamel('example.com') !== false) {
        fwrite(STDERR, 'VIDEOQ_CPU_NETWORK ' . json_encode(['stage' => 'public-dns']) . "\n");
        throw new RuntimeException('Public DNS resolution was allowed');
    }
    $network = ['privateHttps' => true, 'peerCertificateVerified' => true, 'publicIpAndDnsBlocked' => true];
}
if ($action === 'tick' && $row) {
    // Recompute only this owned source; never run general cron or unrelated tasks.
    \local_videoq\synchronizer::run((int)$row->id);
    $jobs = $DB->get_records('local_videoq_exports', ['cmid' => $cm->id, 'courseid' => $course->id]);
    foreach ($jobs as $job) {
        if ($job->status === 'queued' || $job->status === 'uploading') {
            $task = new \local_videoq\task\export_material();
            $task->set_custom_data((object)['jobid' => $job->jobid]);
            $task->execute();
        }
    }
    $row = $DB->get_record('local_videoq_sync', ['cmid' => $cm->id]);
}
$users = [];
$authority = [];
foreach (['teacher', 'learner', 'outsider'] as $name) {
    $user = $DB->get_record('user', ['username' => $prefix . '_' . $name, 'idnumber' => $owner], '*', MUST_EXIST);
    $users[$name] = ['id' => (int)$user->id, 'username' => $user->username];
    $coursecontext = context_course::instance($course->id);
    $authority[$name] = [
        'siteAdmin' => is_siteadmin($user),
        'activeEnrolment' => is_enrolled($coursecontext, $user, '', true),
        'manageContent' => has_capability('local/videoq:managecontent', $coursecontext, $user),
        'manageActivities' => has_capability('moodle/course:manageactivities', $coursecontext, $user),
        'viewReports' => has_capability('local/videoq:viewreports', $coursecontext, $user),
        'sourceVisible' => get_fast_modinfo($course->id, $user->id)->get_cm($cm->id)->uservisible,
    ];
}
echo json_encode(['courseId' => (int)$course->id, 'cmid' => (int)$cm->id, 'users' => $users,
    'manageUrl' => $CFG->wwwroot . '/local/videoq/manage.php?cmid=' . $cm->id,
    'lessonUrl' => $CFG->wwwroot . '/local/videoq/view.php?course=' . $course->id . '&video=' . $cm->id,
    'enabled' => $row ? (bool)$row->enabled : false, 'status' => $row->status ?? 'off',
    'generation' => $row ? (int)$row->generation : null,
    'authority' => $authority,
    'network' => $network,
    'connectionConfigured' => get_config('local_videoq', 'servicemode') === 'lti'],
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
