#!/bin/bash
# Container entrypoint: brings up a real MariaDB (root@localhost via the unix socket, no password - same as
# a fresh install) before idling, so the fake `plesk database --create` can hand out working credentials.
set -e
mkdir -p /run/mysqld
[ -d /var/lib/mysql/mysql ] || mariadb-install-db --user=root --datadir=/var/lib/mysql > /tmp/mariadb-install.log 2>&1
mariadbd --user=root --datadir=/var/lib/mysql --socket=/run/mysqld/mysqld.sock > /tmp/mariadbd.log 2>&1 &
for _ in $(seq 1 30); do mysqladmin ping > /dev/null 2>&1 && break; sleep 0.5; done
exec sleep infinity
