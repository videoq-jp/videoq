<?php
// Disposable CPU acceptance only; no production site or connection is accepted.
if (getenv('VIDEOQ_MOODLE_CPU_FIXTURE') !== '1' || !getenv('MOODLE_DB_PASSWORD')) {
    throw new RuntimeException('Use the owned Moodle CPU acceptance fixture');
}
unset($CFG);
global $CFG;
$CFG = new stdClass();
$CFG->dbtype = 'pgsql';
$CFG->dblibrary = 'native';
$CFG->dbhost = 'db';
$CFG->dbname = 'moodle';
$CFG->dbuser = 'moodle';
$CFG->dbpass = getenv('MOODLE_DB_PASSWORD');
$CFG->prefix = 'mdl_';
$CFG->wwwroot = 'https://moodle.localhost:18443';
$CFG->dataroot = '/var/www/moodledata';
$CFG->admin = 'admin';
$CFG->directorypermissions = 0700;
$CFG->sslproxy = true;
$CFG->site_is_public = false;
$CFG->noemailever = true;
$CFG->pathtophp = '/usr/local/bin/php';
$CFG->disableupdatenotifications = true;
$CFG->debug = 32767;
$CFG->debugdisplay = true;
// Resolve the lab's local names through its private DNS before libcurl applies
// the special *.localhost loopback rule. The real peer TLS chain stays checked.
$CFG->curlsecurityblockedhosts = '0.0.0.0';
$CFG->curlsecurityallowedport = '18443';
$CFG->xsendfile = 'X-Accel-Redirect';
$CFG->xsendfilealiases = ['/protected_moodle/' => $CFG->dataroot . '/filedir'];
require_once(__DIR__ . '/lib/setup.php');
