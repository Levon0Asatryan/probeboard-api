#!/usr/bin/env bash
# Regenerates the TLS fixtures used by the probe executor's tests.
#
# Needs a real OpenSSL 3 (`-not_before`/`-not_after`): macOS's /usr/bin/openssl
# is LibreSSL and does not have them. `brew install openssl@3`, then run this
# with that openssl first on PATH.
#
# The keys here are throwaway fixtures for loopback test servers. They protect
# nothing and are committed on purpose, so the suite needs no generation step.
set -euo pipefail

cd "$(dirname "$0")"
command -v openssl >/dev/null

# Checked by capability, not by version string, and checked *before* anything
# is written. `-not_before`/`-not_after` arrived in OpenSSL 3.2, so a plain
# `^OpenSSL 3` match accepts 3.0.x and then fails partway through -- after
# several committed keys and certificates have already been replaced, leaving
# the fixtures in a state no test can use.
if ! openssl req -help 2>&1 | grep -q -- '-not_after'; then
  echo "this openssl cannot set explicit validity dates, so the expired" >&2
  echo "fixture cannot be generated: $(openssl version)" >&2
  echo "needs OpenSSL 3.2 or newer (macOS ships LibreSSL; brew install openssl@3)" >&2
  exit 1
fi

# Everything is generated into a scratch directory and moved into place only
# once the whole run has succeeded, so a failure part-way leaves the committed
# fixtures untouched.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
out="$PWD"
cd "$work"

SAN_LOCAL="subjectAltName=DNS:localhost,IP:127.0.0.1"

# A CA the tests trust explicitly, so a hostname mismatch is reported as a
# mismatch rather than being masked by an untrusted-chain error first.
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt -days 7300 -nodes \
  -subj "/CN=probeboard test CA" -addext "basicConstraints=critical,CA:TRUE"

sign() { # name, subject, san, extra...
  local name="$1" subj="$2" san="$3"; shift 3
  openssl req -newkey rsa:2048 -keyout "$name.key" -out "$name.csr" -nodes -subj "$subj"
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$name.crt" -extfile <(printf '%s\n' "$san") "$@"
  rm -f "$name.csr"
}

# Trusted and correct: the happy path.
sign valid "/CN=localhost" "$SAN_LOCAL" -days 7300
# Trusted chain, wrong name: isolates ERR_TLS_CERT_ALTNAME_INVALID.
sign wrong-name "/CN=other.test" "subjectAltName=DNS:other.test" -days 7300

# Untrusted on purpose -- no CA involved, so these need no trust setup at all.
openssl req -x509 -newkey rsa:2048 -keyout self-signed.key -out self-signed.crt \
  -days 7300 -nodes -subj "/CN=localhost" -addext "$SAN_LOCAL"
# Expired: OpenSSL reports CERT_HAS_EXPIRED ahead of the self-signed problem,
# so this reaches TLS_EXPIRED without a trusted chain (verified live).
openssl req -x509 -newkey rsa:2048 -keyout expired.key -out expired.crt -nodes \
  -subj "/CN=localhost" -addext "$SAN_LOCAL" \
  -not_before 20200101000000Z -not_after 20210101000000Z

rm -f ca.srl
mv ./*.crt ./*.key "$out"/
cd "$out"
echo "regenerated:"; ls -1 ./*.crt
