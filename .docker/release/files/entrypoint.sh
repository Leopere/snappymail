#!/bin/sh
set -eu

DEBUG=${DEBUG:-}
if [ "$DEBUG" = 'true' ]; then
    set -x
fi
UPLOAD_MAX_SIZE=${UPLOAD_MAX_SIZE:-25M}
MEMORY_LIMIT=${MEMORY_LIMIT:-256M}
SECURE_COOKIES=${SECURE_COOKIES:-true}

# Set attachment size limit
sed -i "s/<UPLOAD_MAX_SIZE>/$UPLOAD_MAX_SIZE/g" /usr/local/etc/php-fpm.d/php-fpm.conf /etc/nginx/nginx.conf
sed -i "s/<MEMORY_LIMIT>/$MEMORY_LIMIT/g" /usr/local/etc/php-fpm.d/php-fpm.conf

# Secure cookies
if [ "${SECURE_COOKIES}" = 'true' ]; then
    echo "[INFO] Secure cookies activated"
        {
        	echo 'session.cookie_httponly = On';
        	echo 'session.cookie_secure = On';
        	echo 'session.use_only_cookies = On';
        } > /usr/local/etc/php/conf.d/cookies.ini;
fi

echo "[INFO] Snappymail version: $( ls /snappymail/snappymail/v )"

# Set permissions on snappymail data
echo "[INFO] Setting permissions on /var/lib/snappymail"
chown -R www-data:www-data /var/lib/snappymail/
chmod 550 /var/lib/snappymail/
find /var/lib/snappymail/ -type d -exec chmod 750 {} \;

# Keep the image-managed RockSign plugin available in Admin -> Packages even
# when /var/lib/snappymail is an existing persistent volume. Plugin settings
# remain in the separate persistent configuration file.
if [ -d /opt/snappymail-plugins/rocksign ]; then
    ROCKSIGN_PLUGIN_PARENT=/var/lib/snappymail/_data_/_default_/plugins
    ROCKSIGN_PLUGIN_DIR=/var/lib/snappymail/_data_/_default_/plugins/rocksign
    ROCKSIGN_PLUGIN_NEW=${ROCKSIGN_PLUGIN_DIR}.new
    ROCKSIGN_PLUGIN_OLD=${ROCKSIGN_PLUGIN_DIR}.old
    mkdir -p "$ROCKSIGN_PLUGIN_PARENT"
    chown www-data:www-data \
        /var/lib/snappymail/_data_ \
        /var/lib/snappymail/_data_/_default_ \
        "$ROCKSIGN_PLUGIN_PARENT"
    chmod 750 \
        /var/lib/snappymail/_data_ \
        /var/lib/snappymail/_data_/_default_ \
        "$ROCKSIGN_PLUGIN_PARENT"
    rm -rf "$ROCKSIGN_PLUGIN_NEW" "$ROCKSIGN_PLUGIN_OLD"
    mkdir "$ROCKSIGN_PLUGIN_NEW"
    cp -R /opt/snappymail-plugins/rocksign/. "$ROCKSIGN_PLUGIN_NEW/"
    chown -R root:root "$ROCKSIGN_PLUGIN_NEW"
    find "$ROCKSIGN_PLUGIN_NEW" -type d -exec chmod 755 {} \;
    find "$ROCKSIGN_PLUGIN_NEW" -type f -exec chmod 644 {} \;
    if [ -e "$ROCKSIGN_PLUGIN_DIR" ]; then
        mv "$ROCKSIGN_PLUGIN_DIR" "$ROCKSIGN_PLUGIN_OLD"
    fi
    mv "$ROCKSIGN_PLUGIN_NEW" "$ROCKSIGN_PLUGIN_DIR"
    rm -rf "$ROCKSIGN_PLUGIN_OLD"
fi

# Create snappymail default config if absent
SNAPPYMAIL_CONFIG_FILE=/var/lib/snappymail/_data_/_default_/configs/application.ini
if [ ! -f "$SNAPPYMAIL_CONFIG_FILE" ]; then
    echo "[INFO] Creating default Snappymail configuration: $SNAPPYMAIL_CONFIG_FILE"
    # Run snappymail and exit. This populates the snappymail data directory and generates the config file
    # On error, print php exception and exit
    EXITCODE=
    su - www-data -s /bin/sh -c 'php /snappymail/index.php' > /tmp/out || EXITCODE=$?
    if [ -n "$EXITCODE" ]; then
        cat /tmp/out
        exit "$EXITCODE"
    fi
fi

# Replace the managed BoomPay domain configuration atomically on every release.
# Mailbox credentials remain in session storage; this file contains transport
# hosts and TLS policy only.
MANAGED_BOOMPAY_DOMAIN=/opt/snappymail-domains/boompay.ca.json
if [ -f "$MANAGED_BOOMPAY_DOMAIN" ]; then
    SNAPPYMAIL_DOMAIN_PARENT=/var/lib/snappymail/_data_/_default_
    SNAPPYMAIL_DOMAIN_DIR=${SNAPPYMAIL_DOMAIN_PARENT}/domains
    SNAPPYMAIL_BOOMPAY_DOMAIN=${SNAPPYMAIL_DOMAIN_DIR}/boompay.ca.json
    if [ -L "$SNAPPYMAIL_DOMAIN_PARENT" ] || [ ! -d "$SNAPPYMAIL_DOMAIN_PARENT" ] \
        || [ "$(readlink -f "$SNAPPYMAIL_DOMAIN_PARENT")" != "$SNAPPYMAIL_DOMAIN_PARENT" ]; then
        echo "[ERROR] Refusing unsafe SnappyMail data directory" >&2
        exit 1
    fi
    mkdir -p "$SNAPPYMAIL_DOMAIN_DIR"
    if [ -L "$SNAPPYMAIL_DOMAIN_DIR" ] || [ ! -d "$SNAPPYMAIL_DOMAIN_DIR" ] \
        || [ "$(readlink -f "$SNAPPYMAIL_DOMAIN_DIR")" != "$SNAPPYMAIL_DOMAIN_DIR" ]; then
        echo "[ERROR] Refusing unsafe SnappyMail domain configuration directory" >&2
        exit 1
    fi
    SNAPPYMAIL_DOMAIN_STAGE=$(mktemp -d /tmp/snappymail-managed-domain.XXXXXX)
    cleanup_managed_domain_stage() {
        if [ -n "${SNAPPYMAIL_DOMAIN_STAGE:-}" ]; then
            rm -rf "$SNAPPYMAIL_DOMAIN_STAGE"
        fi
    }
    trap cleanup_managed_domain_stage EXIT HUP INT TERM
    cp "$MANAGED_BOOMPAY_DOMAIN" "$SNAPPYMAIL_DOMAIN_STAGE/boompay.ca.json"
    chown www-data:www-data "$SNAPPYMAIL_DOMAIN_STAGE/boompay.ca.json"
    chmod 750 "$SNAPPYMAIL_DOMAIN_DIR"
    chmod 640 "$SNAPPYMAIL_DOMAIN_STAGE/boompay.ca.json"
    chown www-data:www-data "$SNAPPYMAIL_DOMAIN_DIR"
    mv -fT "$SNAPPYMAIL_DOMAIN_STAGE/boompay.ca.json" "$SNAPPYMAIL_BOOMPAY_DOMAIN"
    rmdir "$SNAPPYMAIL_DOMAIN_STAGE"
    SNAPPYMAIL_DOMAIN_STAGE=
    trap - EXIT HUP INT TERM
fi

echo "[INFO] Overriding values in snappymail configuration: $SNAPPYMAIL_CONFIG_FILE"
# Enable output of snappymail logs
sed '/^\; Enable logging/{
N
s/enable = Off/enable = On/
}' -i $SNAPPYMAIL_CONFIG_FILE
# Redirect snappymail logs to stderr /stdout
sed 's/^filename = .*/filename = "stderr"/' -i $SNAPPYMAIL_CONFIG_FILE
sed 's/^write_on_error_only = .*/write_on_error_only = Off/' -i $SNAPPYMAIL_CONFIG_FILE
sed 's/^write_on_php_error_only = .*/write_on_php_error_only = On/' -i $SNAPPYMAIL_CONFIG_FILE
# Always enable snappymail Auth logging
sed 's/^auth_logging = .*/auth_logging = On/' -i $SNAPPYMAIL_CONFIG_FILE
sed 's/^auth_logging_filename = .*/auth_logging_filename = "auth.log"/' -i $SNAPPYMAIL_CONFIG_FILE
sed 's/^auth_logging_format = .*/auth_logging_format = "[{date:Y-m-d H:i:s}] Auth failed: ip={request:ip} user={imap:login} host={imap:host} port={imap:port}"/' -i $SNAPPYMAIL_CONFIG_FILE
sed 's/^auth_syslog = .*/auth_syslog = Off/' -i $SNAPPYMAIL_CONFIG_FILE
# Conversation view is the product default. Servers without THREAD support are
# still handled as ordinary unthreaded lists by the capability gate.
sed 's/^mail_use_threads = .*/mail_use_threads = On/' -i $SNAPPYMAIL_CONFIG_FILE

(
    while ! nc -vz -w 1 127.0.0.1 8888 > /dev/null 2>&1; do echo "[INFO] Checking whether nginx is alive"; sleep 1; done
    while ! nc -vz -w 1 127.0.0.1 9000 > /dev/null 2>&1; do echo "[INFO] Checking whether php-fpm is alive"; sleep 1; done
    # Create snappymail admin password if absent
    SNAPPYMAIL_ADMIN_PASSWORD_FILE=/var/lib/snappymail/_data_/_default_/admin_password.txt
    if [ ! -f "$SNAPPYMAIL_ADMIN_PASSWORD_FILE" ]; then
        echo "[INFO] Creating Snappymail admin password file: $SNAPPYMAIL_ADMIN_PASSWORD_FILE"
        wget -T 1 -qO- 'http://127.0.0.1:8888/?/AdminAppData/0/12345/' > /dev/null
        echo "[INFO] Snappymail Admin Panel ready at http://localhost:8888/?admin. Login using password in $SNAPPYMAIL_ADMIN_PASSWORD_FILE"
    fi

    wget -T 1 -qO- 'http://127.0.0.1:8888/' > /dev/null
    echo "[INFO] Snappymail ready at http://localhost:8888/"
) &

# RUN !
exec /usr/bin/supervisord -c /supervisor.conf --pidfile /run/supervisord.pid
