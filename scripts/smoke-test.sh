#!/usr/bin/env bash
# HTTP smoke test for the Chapters of Change API.
#
# Boots the compiled API (in-memory store, synthetic seed data, no Redis /
# Postgres needed) and drives the full donor→recipient workflow over real
# HTTP: dev-token auth, listing creation, idempotent donation request,
# cross-organization approval denial (403), approval, in-transit, delivered,
# completion — plus the bcrypt credential login (success / wrong password /
# unknown email). Every step asserts its expected status; the script exits
# non-zero on the first mismatch.
#
# Usage: npm run build:api && bash scripts/smoke-test.sh
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-4000}"
BASE="http://localhost:${PORT}"
API_LOG="$(mktemp -t chapters-api.XXXXXX.log)"
FAILURES=0

node apps/api/dist/main.js >"$API_LOG" 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null; wait $API_PID 2>/dev/null' EXIT

for i in $(seq 1 50); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.3
  [ "$i" = "50" ] && { echo "API did not start; log:"; cat "$API_LOG"; exit 1; }
done

step() { echo; echo "== $*"; }
expect() { # expect <label> <actual> <wanted>
  if [ "$2" = "$3" ]; then echo "  OK  $1: $2"; else echo "  FAIL $1: got $2, want $3"; FAILURES=$((FAILURES+1)); fi
}
# req <method> <path> <token|-> <body|-> [extra curl args...] -> prints "HTTP_CODE <body>"
req() {
  local method="$1" path="$2" token="$3" body="$4"; shift 4
  local args=(-s -X "$method" -w $'\n%{http_code}')
  [ "$token" != "-" ] && args+=(-H "Authorization: Bearer $token")
  [ "$body" != "-" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$@" "$BASE$path"
}
code() { tail -n1 <<<"$1"; }
json() { sed '$d' <<<"$1" | jq -r "$2"; }

step "GET /health (worker must report disabled — no REDIS_URL)"
OUT=$(req GET /health - -)
expect "health http" "$(code "$OUT")" "200"
echo "  worker: $(json "$OUT" '.notificationWorker.state') — $(json "$OUT" '.notificationWorker.detail')"
grep -q "Notification worker disabled" "$API_LOG" && echo "  OK  boot log contains the worker-disabled line" || { echo "  FAIL boot log missing worker-disabled line"; FAILURES=$((FAILURES+1)); }

step "POST /auth/dev-token — donor (default) and both org admins (DEV ONLY endpoint)"
DONOR_TOKEN=$(json "$(req POST /auth/dev-token - '{}')" '.accessToken')
ORG_TOKEN=$(json "$(req POST /auth/dev-token - '{"userId":"user-org-admin-1"}')" '.accessToken')
ORG_MEMBER_TOKEN=$(json "$(req POST /auth/dev-token - '{"userId":"user-org-member-1"}')" '.accessToken')
OTHER_ORG_TOKEN=$(json "$(req POST /auth/dev-token - '{"userId":"user-org-admin-2"}')" '.accessToken')
[ -n "$DONOR_TOKEN" ] && [ -n "$ORG_TOKEN" ] && echo "  OK  tokens issued for donor + org users" || { echo "  FAIL token issuance"; FAILURES=$((FAILURES+1)); }

step "POST /auth/login — bcrypt credential login (seeded synthetic users)"
OUT=$(req POST /auth/login - '{"email":"donor@example.com","password":"synthetic-donor-pass"}')
expect "login donor http" "$(code "$OUT")" "200"
LOGIN_TOKEN=$(json "$OUT" '.accessToken')
[ -n "$LOGIN_TOKEN" ] && echo "  OK  login returned a JWT" || { echo "  FAIL login token missing"; FAILURES=$((FAILURES+1)); }
OUT=$(req POST /auth/login - '{"email":"donor@example.com","password":"wrong-password"}')
expect "login wrong password http" "$(code "$OUT")" "401"
OUT=$(req POST /auth/login - '{"email":"ghost@example.com","password":"whatever-pass"}')
expect "login unknown email http" "$(code "$OUT")" "401"

step "POST /auth/register — a second donor (used below for a workflow-level 403)"
OUT=$(req POST /auth/register - '{"email":"donor2@example.com","password":"donor-two-password","role":"DONOR","displayName":"Synthetic Donor Two"}')
expect "register http" "$(code "$OUT")" "201"
OUT=$(req POST /auth/login - '{"email":"donor2@example.com","password":"donor-two-password"}')
DONOR2_TOKEN=$(json "$OUT" '.accessToken')
[ -n "$DONOR2_TOKEN" ] && echo "  OK  registered donor can log in" || { echo "  FAIL donor2 login"; FAILURES=$((FAILURES+1)); }

step "POST /listings — donor creates a listing"
OUT=$(req POST /listings "$DONOR_TOKEN" '{"title":"Naruto Vol. 1-5 bundle","genre":"Manga","language":"English","condition":"GOOD","ageSuitability":"TEEN","quantity":5}')
expect "create listing http" "$(code "$OUT")" "201"
LISTING_ID=$(json "$OUT" '.id')
echo "  listing id: $LISTING_ID (availableQuantity=$(json "$OUT" '.availableQuantity'))"

step "GET /listings — public search finds it"
OUT=$(req GET "/listings?query=Naruto" - -)
expect "search total" "$(json "$OUT" '.total')" "1"

step "POST /donations — org requests the donation (Idempotency-Key: smoke-key-1)"
OUT=$(req POST /donations "$ORG_TOKEN" "{\"listingId\":\"$LISTING_ID\",\"quantity\":2}" -H 'Idempotency-Key: smoke-key-1')
expect "request http" "$(code "$OUT")" "201"
DONATION_ID=$(json "$OUT" '.donation.id')
expect "request status" "$(json "$OUT" '.donation.status')" "PENDING_APPROVAL"
expect "deduplicated flag" "$(json "$OUT" '.deduplicated')" "false"
echo "  donation id: $DONATION_ID"

step "POST /donations replay — same Idempotency-Key returns the ORIGINAL donation"
OUT=$(req POST /donations "$ORG_TOKEN" "{\"listingId\":\"$LISTING_ID\",\"quantity\":2}" -H 'Idempotency-Key: smoke-key-1')
expect "replay http" "$(code "$OUT")" "201"
expect "replay donation id" "$(json "$OUT" '.donation.id')" "$DONATION_ID"
expect "replay deduplicated flag" "$(json "$OUT" '.deduplicated')" "true"

step "POST /donations/:id/approve — cross-organization approval must be 403"
OUT=$(req POST "/donations/$DONATION_ID/approve" "$OTHER_ORG_TOKEN" '{}')
expect "cross-org approve http" "$(code "$OUT")" "403"
OUT=$(req POST "/donations/$DONATION_ID/approve" "$DONOR2_TOKEN" '{}')
expect "non-owner donor approve http (workflow RBAC)" "$(code "$OUT")" "403"

step "Lifecycle — owning donor approves, ships, delivers; org confirms completion"
OUT=$(req POST "/donations/$DONATION_ID/approve" "$DONOR_TOKEN" '{}')
expect "approve http" "$(code "$OUT")" "201"
expect "status after approve" "$(json "$OUT" '.status')" "APPROVED"
OUT=$(req POST "/donations/$DONATION_ID/in-transit" "$DONOR_TOKEN" '{}')
expect "status after in-transit" "$(json "$OUT" '.status')" "IN_TRANSIT"
OUT=$(req POST "/donations/$DONATION_ID/delivered" "$DONOR_TOKEN" '{}')
expect "status after delivered" "$(json "$OUT" '.status')" "DELIVERED"
OUT=$(req POST "/donations/$DONATION_ID/complete" "$ORG_MEMBER_TOKEN" '{}')
expect "status after complete" "$(json "$OUT" '.status')" "COMPLETED"

step "Rejection branch — donor rejects a second request; terminal state rejects approval (409)"
OUT=$(req POST /listings "$DONOR_TOKEN" '{"title":"One Piece Vol. 1","genre":"Manga","language":"English","condition":"GOOD","ageSuitability":"TEEN","quantity":2}')
LISTING2_ID=$(json "$OUT" '.id')
OUT=$(req POST /donations "$ORG_TOKEN" "{\"listingId\":\"$LISTING2_ID\",\"quantity\":1}" -H 'Idempotency-Key: smoke-key-2')
DONATION2_ID=$(json "$OUT" '.donation.id')
OUT=$(req POST "/donations/$DONATION2_ID/reject" "$DONOR_TOKEN" '{"reason":"Condition not as described"}')
expect "reject http" "$(code "$OUT")" "201"
expect "status after reject" "$(json "$OUT" '.status')" "REJECTED"
OUT=$(req POST "/donations/$DONATION2_ID/approve" "$DONOR_TOKEN" '{}')
expect "approve-after-reject http (illegal transition)" "$(code "$OUT")" "409"

step "GET /donations — donor and org each see the completed donation; anonymous gets 401"
OUT=$(req GET /donations "$DONOR_TOKEN" -)
expect "donor list contains donation" "$(json "$OUT" "[.[].id] | index(\"$DONATION_ID\") != null")" "true"
expect "donor list status" "$(json "$OUT" ".[] | select(.id==\"$DONATION_ID\") | .status")" "COMPLETED"
OUT=$(req GET /donations "$ORG_TOKEN" -)
expect "org list contains donation" "$(json "$OUT" "[.[].id] | index(\"$DONATION_ID\") != null")" "true"
OUT=$(req GET /donations - -)
expect "anonymous list http" "$(code "$OUT")" "401"

echo
if [ "$FAILURES" -eq 0 ]; then echo "SMOKE TEST PASSED — all steps behaved as expected."; else echo "SMOKE TEST FAILED — $FAILURES expectation(s) missed."; exit 1; fi
