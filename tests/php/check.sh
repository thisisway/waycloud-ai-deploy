#!/bin/sh
# Lints every addon PHP file and runs the addon tests. Meant for PHP 8.1 (the version WHMCS runs):
#   MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/app" -w /app php:8.1-cli sh tests/php/check.sh
set -u
bad=0
for f in $(find whmcs -name '*.php') tests/php/*.php; do
  out=$(php -l "$f" 2>&1)
  case "$out" in
    "No syntax errors"*) ;;
    *) echo "$out"; bad=1 ;;
  esac
done
if [ "$bad" = 0 ]; then echo "lint: all files OK"; else echo "lint: PROBLEMS"; exit 1; fi
php tests/php/run.php
