#!/usr/bin/env bash
# Way Cloud deploy agent. Runs as root on a Plesk server and publishes sites for the Way Cloud MCP service.
#
# Pull model: it only makes outbound HTTPS calls. Every step below is deliberate:
#  - a job is trusted only after each field passes a strict check (domain, uuid, sha256, size, PHP version);
#  - the package must match its SHA-256 before anything is extracted;
#  - the live docroot is never touched until the new files are fully prepared; the swap is two renames on the
#    same filesystem, and any failure after it restores the previous version (no half-published site);
#  - snapshots and work files live OUTSIDE the customer's writable area (root-owned).
#
# Config comes from the environment (see /etc/waycloud-agent.env written by install.sh).
set -uo pipefail

: "${WC_API:?WC_API is required}" "${WC_TOKEN:?WC_TOKEN is required}"
WC_INTERVAL="${WC_INTERVAL:-5}"
WC_VHOSTS="${WC_VHOSTS:-/var/www/vhosts}"
WC_STATE="${WC_STATE:-/var/lib/waycloud-agent}"
WC_WORK="${WC_WORK:-$WC_VHOSTS/.waycloud-agent}"
WC_PLESK="${WC_PLESK:-plesk}"
WC_LE_EMAIL="${WC_LE_EMAIL:-}"
WC_SSL_MODE="${WC_SSL_MODE:-auto}"          # auto | off
WC_CHECK_ADDR="${WC_CHECK_ADDR:-127.0.0.1}"  # where the local health check connects
WC_CHECK_HTTP_PORT="${WC_CHECK_HTTP_PORT:-80}"
WC_CHECK_HTTPS_PORT="${WC_CHECK_HTTPS_PORT:-443}"
WC_ONCE="${WC_ONCE:-0}"                      # 1 = one poll and exit (used by tests)
WC_MAX_BYTES="${WC_MAX_BYTES:-524288000}"    # 500 MB
WC_MAX_FILES="${WC_MAX_FILES:-50000}"

BODY="$WC_STATE/response.json"
PHP_OK=" 7.4 8.0 8.1 8.2 8.3 8.4 "

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

api() { # api METHOD PATH [json-file] -> prints the HTTP status (000 on network error), body in $BODY
  local args=(-sS -m 60 -o "$BODY" -w '%{http_code}' -X "$1" -H "Authorization: Bearer $WC_TOKEN")
  [ -n "${3:-}" ] && args+=(-H 'Content-Type: application/json' --data-binary "@$3")  # a bodiless request must not claim a JSON body
  curl "${args[@]}" "$WC_API$2" 2>/dev/null || echo 000
}

post_report() { # post_report jobs|domain-jobs JOB STATUS [step] [error_code] [ssl true|false]
  local kind=$1 id=$2 status=$3 step=${4:-} code=${5:-} ssl=${6:-}
  # empty fields are dropped; ssl is true/false/absent
  jq -cn --arg s "$status" --arg st "$step" --arg c "$code" --argjson ssl "${ssl:-null}"     '{status:$s, step:$st, error_code:$c, ssl:$ssl} | with_entries(select(.value != "" and .value != null))' > "$WC_STATE/report.json"
  local http; http=$(api POST "/$kind/$id/report" "$WC_STATE/report.json")
  log "$kind job=$id report=$status step=$step code=$code ssl=$ssl http=$http"
  [ "$http" = 200 ] || log "$kind job=$id report rejected: $(head -c 200 "$BODY" 2>/dev/null)"
}
report() { post_report jobs "$@"; }         # report JOB STATUS [step] [error_code] [ssl]
report_domain() { post_report domain-jobs "$@"; }

is_uuid()   { [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; }
is_sha256() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
is_uint()   { [[ "$1" =~ ^[0-9]{1,12}$ ]]; }
is_domain() { # lowercase DNS name, at least two labels, no empty label, <= 253 chars
  [[ ${#1} -le 253 && "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]
}

prune() { # prune DIR KEEP: remove everything but the KEEP newest entries
  local dir=$1 keep=$2
  [ -d "$dir" ] || return 0
  ls -1dt "$dir"/* 2>/dev/null | tail -n +"$((keep + 1))" | while IFS= read -r p; do rm -rf -- "$p"; done
}

has_le_cert() { # is the certificate served for $1 issued by Let's Encrypt?
  local issuer
  issuer=$(timeout 10 openssl s_client -connect "$WC_CHECK_ADDR:$WC_CHECK_HTTPS_PORT" -servername "$1" </dev/null 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null)
  [[ "$issuer" == *"Let's Encrypt"* ]]
}

# Plesk creates every site with "redirect HTTP to HTTPS" on. Without a valid certificate that redirect makes the site
# unreachable (and blocks the Let's Encrypt check itself), so it stays off until the certificate is there.
set_redirect() { # set_redirect DOMAIN true|false
  "$WC_PLESK" bin site --update "$1" -ssl-redirect "$2" >> "$WC_STATE/plesk.log" 2>&1 || true
}

ensure_ssl() { # ensure_ssl DOMAIN [www]  prints true|false. A missing certificate never fails a deploy: the site is live over HTTP meanwhile.
  local domain=$1 www=${2:-} names=(-d "$1")
  [ "$www" = true ] && names+=(-d "www.$1")
  if has_le_cert "$domain"; then set_redirect "$domain" true; echo true; return; fi
  set_redirect "$domain" false
  if [ "$WC_SSL_MODE" = auto ] && [ -n "$WC_LE_EMAIL" ]; then
    timeout 180 "$WC_PLESK" bin extension --exec letsencrypt cli.php "${names[@]}" -m "$WC_LE_EMAIL" >> "$WC_STATE/letsencrypt.log" 2>&1 || true
    if has_le_cert "$domain"; then set_redirect "$domain" true; echo true; return; fi
  fi
  echo false
}

# Sites still waiting for a certificate (DNS not there yet, Let's Encrypt limits...) are retried with growing pauses, for 24 h.
SSL_DELAYS=(120 300 600 1200 2400 3600)
# One file per (domain, who to tell): a deploy and a domain switch on the same domain both need their own report.
# Name: <domain>@deploy | <domain>@domain ("@" cannot be part of a domain). Content: JOB FIRST_TS TRIES NEXT_TS WWW
mark_ssl_pending() { # mark_ssl_pending JOB DOMAIN [deploy|domain] [www]
  local now; now=$(date +%s)
  mkdir -p "$WC_STATE/ssl-pending"
  echo "$1 $now 0 $(( now + SSL_DELAYS[0] )) ${4:-false}" > "$WC_STATE/ssl-pending/$2@${3:-deploy}"
}

retry_ssl() {
  local f name domain id first tries next kind www now delay
  now=$(date +%s)
  for f in "$WC_STATE"/ssl-pending/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f"); domain=${name%@*}; kind=${name#*@}
    read -r id first tries next www < "$f" || continue
    www=${www:-false}
    if (( now - first > 86400 )); then log "ssl: giving up on $domain after 24 hours"; rm -f "$f"; continue; fi
    (( now < next )) && continue
    if [ "$(ensure_ssl "$domain" "$www")" = true ]; then
      log "ssl: certificate ready for $domain"
      rm -f "$f"
      if [ "$kind" = domain ]; then report_domain "$id" active ssl_ready "" true; else report "$id" published ssl_ready "" true; fi
    else
      tries=$(( tries + 1 )); delay=${SSL_DELAYS[$(( tries < 5 ? tries : 5 ))]}
      echo "$id $first $tries $(( now + delay )) $www" > "$f"
    fi
  done
}

local_check() { # 2xx from this very server (Host header + --resolve), independent of public DNS and certificates
  local domain=$1 code
  code=$(curl -sk -L --max-redirs 3 -m 20 -o /dev/null -w '%{http_code}' \
    --resolve "$domain:$WC_CHECK_HTTP_PORT:$WC_CHECK_ADDR" --resolve "$domain:$WC_CHECK_HTTPS_PORT:$WC_CHECK_ADDR" \
    "http://$domain:$WC_CHECK_HTTP_PORT/" 2>/dev/null || echo 000)
  [[ "$code" =~ ^2[0-9][0-9]$ ]]
}

deploy() { # deploy JOB-JSON-FILE
  local f=$1 id domain sha size php keep
  id=$(jq -r '.job_id // empty' "$f");      domain=$(jq -r '.domain // empty' "$f")
  sha=$(jq -r '.sha256 // empty' "$f");     size=$(jq -r '.size_bytes // empty' "$f")
  php=$(jq -r '.php_version // empty' "$f"); keep=$(jq -r '.keep_snapshots // 5' "$f")

  is_uuid "$id" || { log "ignoring a job with an invalid id"; return; }
  log "job=$id starting domain=$domain"

  local reason=""
  is_domain "$domain"   || reason=invalid_domain
  is_sha256 "$sha"      || reason=invalid_hash
  is_uint "$size" && [ "$size" -gt 0 ] && [ "$size" -le "$WC_MAX_BYTES" ] || reason=invalid_size
  [ -z "$php" ] || [[ "$PHP_OK" == *" $php "* ]] || reason=invalid_php
  is_uint "$keep" && [ "$keep" -ge 1 ] && [ "$keep" -le 20 ] || reason=invalid_keep
  [ -z "$reason" ] || { report "$id" failed validate "$reason"; return; }

  local root="$WC_VHOSTS/$domain" doc="$WC_VHOSTS/$domain/httpdocs" work="$WC_WORK/$domain"
  if [ -L "$root" ] || [ -L "$doc" ] || [ ! -d "$doc" ]; then report "$id" failed find_docroot vhost_not_found; return; fi
  # Work files are root-only: the customer can never reach (or swap under) them.
  if ! mkdir -p "$work/releases" "$work/snapshots" "$work/failed" 2>/dev/null; then report "$id" failed prepare work_dir_failed; return; fi
  chmod 700 "$WC_WORK" "$work"
  # The swap must be a rename: same filesystem as the vhost, or it would silently become a slow copy.
  if [ "$(stat -c %d "$work")" != "$(stat -c %d "$root")" ]; then report "$id" failed prepare cross_device; return; fi

  local uid gid mode rel="$work/releases/$id" zip="$WC_STATE/$id.zip"
  uid=$(stat -c %u "$doc"); gid=$(stat -c %g "$doc"); mode=$(stat -c %a "$doc")

  # 1. download and verify
  local http; http=$(api GET "/jobs/$id/package" "" ); mv -f "$BODY" "$zip" 2>/dev/null
  if [ "$http" != 200 ]; then report "$id" failed download download_failed; rm -f "$zip"; return; fi
  if [ "$(stat -c %s "$zip")" != "$size" ]; then report "$id" failed download size_mismatch; rm -f "$zip"; return; fi
  if [ "$(sha256sum "$zip" | cut -d' ' -f1)" != "$sha" ]; then report "$id" failed download sha256_mismatch; rm -f "$zip"; return; fi

  # 2. extract into a private release directory and sanitize
  rm -rf -- "$rel"; mkdir -p "$rel"
  if ! unzip -q -o "$zip" -d "$rel" >/dev/null 2>&1; then report "$id" failed extract extract_failed; rm -rf -- "$rel" "$zip"; return; fi
  rm -f "$zip"
  find "$rel" -type l -delete                        # never keep symlinks
  find "$rel" ! -type f ! -type d -delete            # nor devices, sockets, fifos
  if [ "$(find "$rel" | wc -l)" -gt "$WC_MAX_FILES" ]; then report "$id" failed extract too_many_files; rm -rf -- "$rel"; return; fi
  if ! [ -f "$rel/index.html" ] && ! [ -f "$rel/index.htm" ] && ! [ -f "$rel/index.php" ]; then report "$id" failed validate no_index; rm -rf -- "$rel"; return; fi
  find "$rel" -type d -exec chmod 755 {} + ; find "$rel" -type f -exec chmod 644 {} +
  chown -R -h "$uid:$gid" "$rel"; chmod "$mode" "$rel"
  command -v restorecon >/dev/null 2>&1 && restorecon -R "$rel" >/dev/null 2>&1
  report "$id" validating swap

  # 3. atomic swap: previous docroot -> snapshot, new release -> docroot
  local snap stamp
  stamp=$(date -u +%Y%m%d%H%M%S); snap="$work/snapshots/$stamp-$id"
  if ! mv -T "$doc" "$snap"; then report "$id" failed swap swap_failed; rm -rf -- "$rel"; return; fi
  if ! mv -T "$rel" "$doc"; then
    mv -T "$snap" "$doc" || log "CRITICAL job=$id could not restore $doc from $snap"
    report "$id" failed swap swap_failed; rm -rf -- "$rel"; return
  fi

  # 4. anything wrong from here on restores the previous version
  restore() { # restore STEP CODE
    mv -T "$doc" "$work/failed/$id" 2>/dev/null
    if mv -T "$snap" "$doc"; then report "$id" rolled_back "$1" "$2"; else log "CRITICAL job=$id could not restore $doc"; report "$id" failed "$1" rollback_failed; fi
    prune "$work/failed" 2
  }
  if [ -n "$php" ]; then
    "$WC_PLESK" bin site --update "$domain" -php_handler_id "plesk-php${php//./}-fpm" >> "$WC_STATE/plesk.log" 2>&1 || { restore php php_handler_failed; return; }
  fi
  local_check "$domain" || { restore check local_check_failed; return; }

  local ssl; ssl=$(ensure_ssl "$domain")
  if [ "$ssl" = true ]; then rm -f "$WC_STATE/ssl-pending/$domain@deploy"; else mark_ssl_pending "$id" "$domain" deploy; fi
  prune "$work/snapshots" "$keep"
  report "$id" published finished "" "$ssl"
}

# The customer's own domain becomes the site's main domain (the provisional one goes away). Either the whole switch
# works, or Plesk is put back as it was: the site is never left half-moved.
switch_domain() { # switch_domain JOB-JSON-FILE
  local f=$1 id old new www
  id=$(jq -r '.job_id // empty' "$f"); old=$(jq -r '.old_domain // empty' "$f")
  new=$(jq -r '.domain // empty' "$f"); www=$(jq -r 'if .include_www == true then "true" else "false" end' "$f")
  is_uuid "$id" || { log "domain job rejected: bad job id"; return; }
  if ! is_domain "$old" || ! is_domain "$new" || [ "$old" = "$new" ]; then log "domain job=$id rejected: invalid domain"; report_domain "$id" failed validate invalid_domain; return; fi
  [ -d "$WC_VHOSTS/$old/httpdocs" ] || { log "domain job=$id: $old has no docroot"; report_domain "$id" failed validate vhost_not_found; return; }
  [ ! -e "$WC_VHOSTS/$new" ] || { log "domain job=$id: $new already exists on this server"; report_domain "$id" failed validate domain_exists; return; }
  log "domain job=$id switching $old -> $new"

  # 1. the main domain of the subscription becomes the customer's (Plesk moves the vhost folder along)
  "$WC_PLESK" bin subscription --update "$old" -new-name "$new" >> "$WC_STATE/plesk.log" 2>&1 || { report_domain "$id" failed rename rename_failed; return; }
  if [ ! -d "$WC_VHOSTS/$new/httpdocs" ]; then # not where the deploys expect it: put everything back
    "$WC_PLESK" bin subscription --update "$new" -new-name "$old" >> "$WC_STATE/plesk.log" 2>&1
    log "domain job=$id: docroot not at the new name, reverted"
    report_domain "$id" failed rename docroot_not_moved; return
  fi
  if [ -d "$WC_WORK/$old" ] && [ ! -e "$WC_WORK/$new" ]; then mv -- "$WC_WORK/$old" "$WC_WORK/$new"; fi # the rollback snapshots follow the site

  # 2. the site must answer on the new name before anything else is announced
  if ! local_check "$new"; then
    "$WC_PLESK" bin subscription --update "$new" -new-name "$old" >> "$WC_STATE/plesk.log" 2>&1
    if [ -d "$WC_WORK/$new" ] && [ ! -e "$WC_WORK/$old" ]; then mv -- "$WC_WORK/$new" "$WC_WORK/$old"; fi
    log "domain job=$id: site did not answer on $new, reverted"
    report_domain "$id" failed check local_check_failed; return
  fi

  # 3. certificate (the redirect stays off until it exists); the domain is active either way
  local ssl; ssl=$(ensure_ssl "$new" "$www")
  if [ "$ssl" = true ]; then rm -f "$WC_STATE/ssl-pending/$new@domain"; else mark_ssl_pending "$id" "$new" domain "$www"; fi
  report_domain "$id" active finished "" "$ssl"
}

main() {
  mkdir -p "$WC_STATE"; chmod 700 "$WC_STATE"
  exec 9> "$WC_STATE/agent.lock"; flock -n 9 || { log "another agent instance is running"; exit 1; }
  trap 'log "stopping"; exit 0' TERM INT
  log "agent started api=$WC_API"
  local backoff=0
  while true; do
    retry_ssl
    local http; http=$(api POST /jobs/next)
    case "$http" in
      200) backoff=0; deploy "$BODY"; [ "$WC_ONCE" = 1 ] && exit 0; continue ;;
      204) backoff=0
           local dhttp; dhttp=$(api POST /domain-jobs/next)
           if [ "$dhttp" = 200 ]; then switch_domain "$BODY"; [ "$WC_ONCE" = 1 ] && exit 0; continue; fi ;;
      401) log "token rejected by the service (401)"; [ "$WC_ONCE" = 1 ] && exit 2; backoff=60 ;;
      *)   log "service unreachable or error (http=$http)"; [ "$WC_ONCE" = 1 ] && exit 3; backoff=$(( backoff < 60 ? backoff + 10 : 60 )) ;;
    esac
    [ "$WC_ONCE" = 1 ] && exit 0
    sleep "$(( WC_INTERVAL > backoff ? WC_INTERVAL : backoff ))"
  done
}

main "$@"
