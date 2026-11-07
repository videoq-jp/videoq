ARG PHP_IMAGE=moodlehq/moodle-php-apache:8.3@sha256:1db7b6ed013fcb5268095b5e28c410ba9117d38d9b6a324c100c48fcbe69745e
FROM ${PHP_IMAGE}
ARG MOODLE_REVISION
ARG COMPANION_REVISION
LABEL jp.videoq.test-only="moodle-cpu-acceptance" \
      jp.videoq.moodle-revision="${MOODLE_REVISION}" \
      jp.videoq.companion-revision="${COMPANION_REVISION}"
COPY moodle/ /var/www/html/
COPY companion/plugins/local/videoq/ /var/www/html/public/local/videoq/
COPY companion/plugins/ltisource/videoq/ /var/www/html/public/mod/lti/source/videoq/
COPY companion/lab/ /lab/
COPY fixture/moodle-config.php /var/www/html/config.php
COPY fixture/entrypoint.sh /acceptance/entrypoint.sh
COPY fixture/fixture.php /acceptance/fixture.php
COPY fixture/privacy-fixture.php /acceptance/privacy-fixture.php
COPY companion/lab/apache.conf /etc/apache2/sites-enabled/000-default.conf
COPY companion/lab/mpm-prefork.conf /etc/apache2/mods-enabled/mpm_prefork.conf
COPY companion/lab/php-sync.ini /usr/local/etc/php/conf.d/99-videoq-sync-lab.ini
RUN chmod 0755 /acceptance/entrypoint.sh
ENTRYPOINT ["/acceptance/entrypoint.sh"]
CMD ["apache2-foreground"]
