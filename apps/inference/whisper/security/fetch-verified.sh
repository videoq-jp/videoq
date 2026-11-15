#!/bin/sh
set -eu

source_url=$1
expected_sha=$2
archive_target=$3
case "$source_url" in https://*) ;; *) exit 2 ;; esac
case "$expected_sha" in *[!0-9a-f]*) exit 2 ;; esac
[ "${#expected_sha}" -eq 64 ] || exit 2
case "$archive_target" in /*) ;; *) exit 2 ;; esac

archive_candidate=$(mktemp "${archive_target}.download.XXXXXX")
trap 'rm -f "$archive_candidate"' 0
trap 'exit 1' 1 2 15
for attempt in 1 2 3; do
  # A failed/partial response is never published or handed to an extractor.
  if curl --proto '=https' --proto-redir '=https' -fsSL --connect-timeout 10 --max-time 120 "$source_url" -o "$archive_candidate" &&
    printf '%s  %s\n' "$expected_sha" "$archive_candidate" | sha256sum -c -; then
    mv -f "$archive_candidate" "$archive_target"
    exit 0
  fi
  printf 'Verified source download failed validation (attempt %s/3).\n' "$attempt" >&2
  : > "$archive_candidate"
done
exit 1
