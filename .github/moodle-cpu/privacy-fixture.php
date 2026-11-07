<?php
// Included only after fixture.php's CLI/uid/site/database/owner guards.
if (!defined('CLI_SCRIPT') || !CLI_SCRIPT || !isset($owner, $course, $action) || !$course) {
    throw new RuntimeException('Owned privacy fixture required');
}
$path = '/var/www/moodledata/.videoq-cpu-privacy.json';
$comments = ['export' => 'CPU privacy export ' . $owner, 'delete' => 'CPU privacy delete ' . $owner];
$types = ['export' => \tool_dataprivacy\api::DATAREQUEST_TYPE_EXPORT,
    'delete' => \tool_dataprivacy\api::DATAREQUEST_TYPE_DELETE];
$input = stream_get_contents(STDIN);
$input = $input === '' ? [] : json_decode($input, true, 16, JSON_THROW_ON_ERROR);
if (!is_array($input) || strlen(json_encode($input)) > 2048) {
    throw new RuntimeException('Bounded private fixture input required');
}
if ($action === 'privacy-setup') {
    if (is_file($path) || empty($CFG->noemailever) ||
            \tool_dataprivacy\api::is_automatic_request_approval_on($types['export']) ||
            \tool_dataprivacy\api::is_automatic_request_approval_on($types['delete'])) {
        throw new RuntimeException('Fresh manual privacy fixture required');
    }
    $subject = $DB->get_record('user', ['username' => $prefix . '_learner', 'idnumber' => $owner, 'deleted' => 0], '*', MUST_EXIST);
    if ($input || is_siteadmin($subject) || $subject->auth !== 'manual') {
        throw new RuntimeException('Ordinary owned learner required');
    }
    $state = ['owner' => $owner, 'subject' => (int)$subject->id, 'course' => (int)$course->id,
        'contactBefore' => get_config('tool_dataprivacy', 'contactdataprotectionofficer')];
    if (file_put_contents($path, json_encode($state, JSON_THROW_ON_ERROR)) === false || !chmod($path, 0600)) {
        throw new RuntimeException('Cannot retain owned privacy state');
    }
    set_config('contactdataprotectionofficer', 1, 'tool_dataprivacy');
    echo json_encode(['configured' => true, 'comments' => $comments, 'manualApproval' => true]), "\n";
    return;
}
if (!is_file($path)) {
    throw new RuntimeException('Owned privacy state required');
}
$state = json_decode(file_get_contents($path), true, 16, JSON_THROW_ON_ERROR);
if ($state['owner'] !== $owner || $state['course'] !== (int)$course->id || empty($CFG->noemailever)) {
    throw new RuntimeException('Privacy ownership or mail boundary changed');
}
// Cleanup must not depend on request discovery or on an undeleted subject.
if ($action === 'privacy-reset') {
    if ($state['contactBefore'] === false) {
        unset_config('contactdataprotectionofficer', 'tool_dataprivacy');
    } else {
        set_config('contactdataprotectionofficer', $state['contactBefore'], 'tool_dataprivacy');
    }
    if (!rename($path, $path . '.complete')) {
        throw new RuntimeException('Cannot finish privacy fixture');
    }
    echo json_encode(['restored' => true, 'mailSuppressed' => !empty($CFG->noemailever)]), "\n";
    return;
}
$subject = $DB->get_record('user', ['id' => $state['subject']], '*', MUST_EXIST);
$requests = [];
foreach ($types as $kind => $type) {
    // Moodle forbids TEXT columns in ordinary DML conditions under debugging.
    // Scope by indexed numeric identity/type, then compare complete comments.
    $rows = [];
    $recordset = $DB->get_recordset('tool_dataprivacy_request', ['userid' => $subject->id, 'type' => $type]);
    try {
        foreach ($recordset as $request) {
            if ($request->comments === $comments[$kind]) {
                $rows[] = $request;
            }
        }
    } finally {
        $recordset->close();
    }
    if (count($rows) > 1) {
        throw new RuntimeException('Duplicate owned privacy request');
    }
    $requests[$kind] = $rows ? reset($rows) : null;
}
if ($action === 'privacy-task') {
    $kind = $input['kind'] ?? null;
    $id = $input['taskId'] ?? null;
    if (!is_string($kind) || !isset($requests[$kind]) || !is_int($id) || $id < 1 || count($input) !== 2) {
        throw new RuntimeException('Exact owned task required');
    }
    $task = $DB->get_record('task_adhoc', ['id' => $id], '*', MUST_EXIST);
    $data = json_decode($task->customdata, false, 16, JSON_THROW_ON_ERROR);
    if (!in_array($task->classname, ['\\tool_dataprivacy\\task\\initiate_data_request_task',
            '\\tool_dataprivacy\\task\\process_data_request_task'], true) ||
            (int)($data->requestid ?? 0) !== (int)$requests[$kind]->id || !empty($task->timestarted)) {
        throw new RuntimeException('Unowned or running task refused');
    }
    // Official runner rehydrates actual task user/customdata and takes its lock.
    // Its progress contains private subject data and never enters public output.
    ob_start();
    try {
        \core\cron::setup_user();
        \core\cron::run_adhoc_task($id);
    } finally {
        $log = ob_get_clean();
        $logpath = '/var/www/moodledata/.videoq-cpu-privacy-task-' . $id . '.log';
        file_put_contents($logpath, $log);
        chmod($logpath, 0600);
    }
    echo json_encode(['exactTaskReturned' => true]), "\n";
    return;
}
if ($action === 'privacy-export-evidence') {
    $conversation = $input['conversationId'] ?? null;
    if (!is_string($conversation) || !preg_match('/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/D', $conversation)
            || count($input) !== 3 || !is_string($input['question'] ?? null) ||
            !is_string($input['questionTitle'] ?? null) || !$requests['export'] ||
            (int)$requests['export']->status !== \tool_dataprivacy\api::DATAREQUEST_STATUS_DOWNLOAD_READY) {
        throw new RuntimeException('Completed owned export required');
    }
    $file = get_file_storage()->get_file(context_user::instance((int)$subject->id)->id,
        'tool_dataprivacy', 'export', (int)$requests['export']->id, '/', 'export.zip');
    if (!$file) {
        throw new RuntimeException('Actual core archive required');
    }
    $temporary = $file->copy_content_to_temp();
    chmod($temporary, 0600);
    $zip = new ZipArchive();
    $counts = array_fill_keys(['logs', 'evaluations', 'conversations', 'turns', 'questions', 'replies',
        'checkpoints', 'checkpoint_blobs', 'checkpoint_writes'], 0);
    $accept = function (string $collection, array $record) use (&$counts, $course, $conversation, $input): void {
        if (($record['context'] ?? null) !== (string)$course->id || !is_array($record['data'] ?? null) ||
                str_contains(json_encode($record['data'], JSON_THROW_ON_ERROR), 'CPU privacy teacher reply retained')) {
            throw new RuntimeException('Subject archive exceeded owned scope');
        }
        $data = $record['data'];
        if (in_array($collection, ['conversations', 'turns', 'checkpoints', 'checkpoint_blobs', 'checkpoint_writes'], true)
                && ($data['conversationId'] ?? null) !== $conversation) {
            throw new RuntimeException('Archive contains another conversation');
        }
        if ((in_array($collection, ['logs', 'turns'], true) && ($data['question'] ?? null) !== $input['question']) ||
                ($collection === 'logs' && ($data['feedback'] ?? null) !== 'good') ||
                ($collection === 'questions' && ($data['title'] ?? null) !== $input['questionTitle'])) {
            throw new RuntimeException('Original subject data was not exported');
        }
        $counts[$collection]++;
    };
    try {
        if ($zip->open($temporary) !== true) {
            throw new RuntimeException('Invalid actual archive');
        }
        for ($index = 0; $index < $zip->numFiles; $index++) {
            $name = $zip->getNameIndex($index);
            $parts = explode('/', $name);
            $collection = count($parts) >= 2 ? $parts[count($parts) - 2] : '';
            if (!in_array('VideoQ', $parts, true) || !isset($counts[$collection])) {
                continue;
            }
            if (str_ends_with($name, '.ndjson')) {
                foreach (explode("\n", trim($zip->getFromIndex($index))) as $line) {
                    if ($line !== '') { $accept($collection, json_decode($line, true, 512, JSON_THROW_ON_ERROR)); }
                }
            } else if (str_ends_with($name, '-manifest.json')) {
                $manifest = json_decode($zip->getFromIndex($index), true, 16, JSON_THROW_ON_ERROR);
                $fragments = $manifest['fragments'] ?? null;
                if (!is_int($fragments) || $fragments < 1 || $fragments > 10000 ||
                        ($manifest['context'] ?? null) !== (string)$course->id ||
                        ($manifest['encoding'] ?? null) !== 'UTF-8') {
                    throw new RuntimeException('Invalid model archive manifest');
                }
                $fragmentprefix = substr($name, 0, -strlen('-manifest.json'));
                $text = '';
                for ($part = 1; $part <= $fragments; $part++) {
                    $chunk = $zip->getFromName($fragmentprefix . '-part-' . $part . '.txt');
                    if ($chunk === false || strlen($text) + strlen($chunk) > 67108864) {
                        throw new RuntimeException('Incomplete or oversized model archive');
                    }
                    $text .= $chunk;
                }
                if (($manifest['sha256'] ?? null) !== hash('sha256', $text) ||
                        ($manifest['characters'] ?? null) !== mb_strlen($text, 'UTF-8')) {
                    throw new RuntimeException('Corrupt model archive fragments');
                }
                $accept($collection, ['context' => $manifest['context'],
                    'data' => json_decode($text, true, 512, JSON_THROW_ON_ERROR)]);
            }
        }
        $zip->close();
        echo json_encode(['archiveSha256' => hash_file('sha256', $temporary), 'counts' => $counts,
            'ownedConversationOnly' => true, 'peerTextExcluded' => true]), "\n";
    } finally {
        if (is_file($temporary)) { unlink($temporary); }
    }
    return;
}
if ($action !== 'privacy-status' || $input) {
    throw new RuntimeException('Unknown privacy fixture operation');
}
$result = ['subjectDeleted' => (bool)$subject->deleted, 'requests' => []];
foreach ($requests as $kind => $request) {
    $result['requests'][$kind] = null;
    if (!$request) { continue; }
    $tasks = [];
    foreach ($DB->get_records('task_adhoc', [], 'id') as $task) {
        if (!in_array($task->classname, ['\\tool_dataprivacy\\task\\initiate_data_request_task',
                '\\tool_dataprivacy\\task\\process_data_request_task'], true)) { continue; }
        $data = json_decode($task->customdata);
        if ((int)($data->requestid ?? 0) === (int)$request->id) {
            $tasks[] = ['id' => (int)$task->id, 'kind' => str_contains($task->classname, 'initiate_') ? 'initiate' : 'process'];
        }
    }
    $result['requests'][$kind] = ['id' => (int)$request->id,
        'awaitingApproval' => (int)$request->status === \tool_dataprivacy\api::DATAREQUEST_STATUS_AWAITING_APPROVAL,
        'approved' => (int)$request->status === \tool_dataprivacy\api::DATAREQUEST_STATUS_APPROVED,
        'downloadReady' => (int)$request->status === \tool_dataprivacy\api::DATAREQUEST_STATUS_DOWNLOAD_READY,
        'deleted' => (int)$request->status === \tool_dataprivacy\api::DATAREQUEST_STATUS_DELETED,
        'approvedByAdmin' => (int)$request->dpo === (int)get_admin()->id, 'tasks' => $tasks];
}
echo json_encode($result, JSON_THROW_ON_ERROR), "\n";
