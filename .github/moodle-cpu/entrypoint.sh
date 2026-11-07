#!/bin/sh
set -eu
test "${VIDEOQ_MOODLE_CPU_FIXTURE:-}" = '1'
case "${VIDEOQ_MOODLE_CPU_OWNER:-}" in
    ''|*[!a-f0-9]*) exit 1 ;;
esac
test "${#VIDEOQ_MOODLE_CPU_OWNER}" = 32
test -s /acceptance-ca/root.crt
marker=/var/www/moodledata/.videoq-cpu-owner
if test -e "$marker"; then
    test "$(cat "$marker")" = "$VIDEOQ_MOODLE_CPU_OWNER"
fi
install -d -o www-data -g www-data -m 0700 /var/www/moodledata
if ! test -e "$marker"; then
    (umask 077; printf '%s\n' "$VIDEOQ_MOODLE_CPU_OWNER" > "$marker")
    chown www-data:www-data "$marker"
fi
install -m 0644 /acceptance-ca/root.crt /usr/local/share/ca-certificates/videoq-moodle-cpu.crt
update-ca-certificates >/dev/null
# The companion's pinned php-sync.ini explicitly uses this CA path. Updating
# the system bundle alone leaves cURL with an unreadable CA file (CURLE 77).
install -o www-data -g www-data -m 0644 /acceptance-ca/root.crt /var/www/moodledata/moodleorgca.crt
exec sh /lab/start-moodle.sh "$@"
