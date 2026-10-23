# Status — Chapters of Change

_Last updated: 2026-10-22 (hardening sprint)_

## Done

- npm-workspaces monorepo: `apps/api` (NestJS), `apps/web` (Next.js), `packages/domain` (pure TypeScript, zero framework runtime deps), `packages/app-services` (application/service layer, now shipped as a built ESM package the API loads)
- Domain core:
  - Donation lifecycle state machine (DRAFT → PENDING_APPROVAL → APPROVED/REJECTED → IN_TRANSIT → DELIVERED → COMPLETED, + CANCELLED) with `IllegalTransitionError` and audit history
  - Listing model + search/filter/pagination (`searchListings`)
  - RBAC policy functions for DONOR / ORG_ADMIN / ORG_MEMBER / ADMIN (request, approve, reject, cancel, edit listing, manage org, view)
  - Idempotency key helper + in-memory store modeling the DB unique-constraint contract
  - Transactional outbox types + in-memory dispatcher with exponential backoff and injectable sleeper
- Application/service layer (`packages/app-services`):
  - `WorkflowService` implementing the full donor→recipient workflow on top of the domain package: donor creates listing → organization requests the donation (idempotency-keyed, duplicate submissions return the original) → donor approves (inventory reserved in the same transaction) / rejects → donor marks in-transit → delivered → organization confirms completion. (Per domain RBAC, organizations request and donors approve.)
  - Persistence behind repository interfaces (`Store`): verified in-memory adapter; Prisma adapter written against `prisma/schema.prisma` as the production adapter (structurally typed client, `$transaction` as the atomicity boundary for status change + outbox insert). The interface now includes a credential repository (Prisma maps it onto `User.passwordHash`).
  - Notifications materialized from outbox events: retry with exponential backoff, exhausted events marked FAILED with the last error preserved; a failing notification handler never rolls back donation state
  - `AuthService`: issues HS256 JWTs from stored user records (incl. the seeded synthetic user)
- **Hardening sprint (this update):**
  - **Nest services wired to the tested workflow.** `apps/api` listings/donations services and controllers now delegate to `WorkflowService` (shared singleton store from `RuntimeModule`). The HTTP surface exposes the real workflow: `POST /listings`, public search/get, `POST /donations` (honors the `Idempotency-Key` header), `GET /donations` (per-actor visibility), `GET /donations/:id`, and `POST /donations/:id/{approve,reject,cancel,in-transit,delivered,complete}` — all behind the existing RolesGuard/JWT, with workflow errors mapped to HTTP (AuthorizationError→403, NotFound→404, Validation→400, IllegalTransition→409, Conflict→409). The old scaffold `PATCH /donations/:id/transition` stub is gone. The runtime store is selectable via `STORE_ADAPTER`: `memory` (default, verified, seeded) or `prisma` (selectable, fails fast without `DATABASE_URL`, labeled unverified).
  - **Credential login (bcrypt).** `CredentialAuthService` in app-services: `POST /auth/register` hashes passwords with bcrypt (`bcryptjs`, cost 10) and stores only the hash (separate credential repository, never returned or logged); `POST /auth/login` verifies against the hash and issues the existing HS256 JWT. Unknown email and wrong password return the identical generic 401, and the unknown-email path runs a dummy bcrypt comparison to blunt timing leaks. `POST /auth/dev-token` is kept but labeled DEV ONLY in code, Swagger, README, and `.env.example`; seeded synthetic users have documented SYNTHETIC/DEV-ONLY passwords there (bcrypt-hashed at seed time).
  - **Notification worker.** The job-processing core is a testable, queue-agnostic module (`NotificationWorkerCore`): given an outbox event it delivers a notification, retries with exponential backoff, and after max attempts moves the event to FAILED with the error preserved; `processPending` drains a store's outbox and persists final states. The BullMQ adapter (`apps/api/src/notifications/bullmq.adapter.ts`) wires that core to a real Queue/Worker (repeatable outbox poll, one deliver job per event id) and starts only when `REDIS_URL` is set — labeled UNVERIFIED (no Redis here). Without `REDIS_URL` the API boots with the worker disabled, a clear boot log line, and the state exposed in `GET /health`.
- **JWT auth (`apps/api/src/auth/`):** pure HS256 issuance + verification using Node's built-in `node:crypto` only — alg pinned to HS256 (`none` rejected), `timingSafeEqual` signature comparison, `exp` required and enforced. `JwtService` (Nest adapter), and `RolesGuard` builds `req.user` exclusively from verified Bearer-token claims and distinguishes 401 (no valid token) from 403 (insufficient role). The Vitest suites test this exact module (no copy) via a path alias / relative import.
- Prisma schema (User, Profile, Organization, Listing, DonationRequest, Donation, OutboxEvent, Notification; enums mirror domain) + hand-authored `0001_init` migration SQL consistent with the schema
- Synthetic, clearly-labeled seed data (`prisma/seed.ts`, mirrored in `packages/app-services/src/seed.ts`)
- Web: home, listings search (with loading / empty / error states), donor dashboard, org dashboard, shared state components; Playwright config + E2E spec for the donor→recipient journey (`apps/web/e2e/`)
- Docker Compose (Postgres, Redis, API, Web), Dockerfiles, `.env.example`, GitHub Actions CI (domain, app-services, api typecheck + build + HTTP smoke test, web build, and an e2e job that installs Playwright browsers)

## Verified (actually run in this environment)

- `cd packages/domain && npm test` → **16 passed, 0 failed** (Vitest) — unchanged
- `cd packages/app-services && npm test` → **40 passed, 0 failed** (Vitest, 5 test files)
  - `workflow.test.ts` (16): full happy-path lifecycle with audit-trail and inventory-reservation assertions; notifications delivered to the right recipients; rejection branch; duplicate submission returns the original (incl. 5-way concurrent duplicates creating exactly one donation); authorization failures (org cannot approve its own request, another org's admin cannot approve, non-owner donor cannot approve/ship, cross-org view/cancel/complete denied, donors cannot request); illegal transitions; quantity guards; cancellation releasing reserved inventory; notification handler failing twice then succeeding still delivers via outbox retry; permanently failing handler marks events FAILED with error preserved while donation state stays intact
  - `credentials.test.ts` (7, new): register→login round-trip issuing a JWT with stored claims; stored value is a bcrypt hash (not the password, does not contain it, `bcrypt.compare` verifies true/false correctly); wrong password → `InvalidCredentialsError`; unknown email → the *same* error/message as wrong password; duplicate registration → conflict; invalid email / short password / org-without-organization rejected; seeded synthetic users log in with the documented dev passwords
  - `notification-worker.test.ts` (6, new): first-attempt delivery without sleeping; retry-then-success with backoff delays [100, 200] asserted and failure count recorded; exhaustion → FAILED after max attempts with `lastError` preserved and no sleep after the final attempt; already-delivered events not reprocessed; `processPending` drains a real workflow outbox into notifications and persists DELIVERED; permanently failing delivery marks the event FAILED while the donation stays PENDING_APPROVAL
  - `jwt.test.ts` (8): sign/verify round-trip, seeded-user token, expired token rejected, tampered payload (role-escalation forgery) rejected, wrong secret rejected, `alg=none` rejected, malformed tokens rejected, Bearer extraction
  - `auth.test.ts` (3): issuance from stored user records with correct claims, seeded-user issuance, unknown user refused
- Typechecks: `packages/domain`, `packages/app-services`, `apps/api`, and `apps/web` all `tsc --noEmit` → **exit 0**
- **Build chain:** `npm run build:api` (domain → app-services ESM dist → api) → **exit 0**; `next build` for web → **exit 0** (5 routes)
- **HTTP smoke test (`scripts/smoke-test.sh`, run twice, PASSED both times):** boots the compiled API with no Redis/Postgres and drives the real workflow with curl —
  - `GET /health` → 200, notification worker reports `disabled` (REDIS_URL not set) and the boot log contains the worker-disabled line; API boots cleanly without Redis
  - `POST /auth/dev-token` issues tokens for the seeded donor + org users; `POST /auth/login` succeeds for seeded synthetic users (bcrypt), wrong password → **401**, unknown email → **401**; `POST /auth/register` → 201 and the new user can log in
  - Donor creates a listing (201); public search finds it; org requests it with `Idempotency-Key: smoke-key-1` → 201 `PENDING_APPROVAL`; replaying the same key returns the **same donation id** with `deduplicated: true`
  - Cross-organization approval attempt → **403**; a different (non-owner) donor's approval attempt → **403** from the workflow RBAC layer
  - Owning donor approves → `APPROVED`, marks in-transit → `IN_TRANSIT`, delivered → `DELIVERED`; org member confirms → `COMPLETED`
  - Second request rejected by the donor → `REJECTED`; approving it afterwards → **409** (illegal transition)
  - `GET /donations` shows the completed donation to both the donor and the org; anonymous request → **401**

## Not verified / honest limitations

- **No live Postgres/Redis, no Docker** in this environment — Compose/Dockerfiles are authored but not run, and the Prisma adapter has **not** been executed against a real database. `STORE_ADAPTER=prisma` is wired and fails fast without `DATABASE_URL`, but it remains selectable-but-unverified. The verified persistence adapter is the in-memory one (state resets on restart); the workflow's transactional guarantees are proven against its transaction contract, with Prisma `$transaction` as the production boundary.
- **BullMQ adapter has never run against a live Redis.** Its delivery core (`NotificationWorkerCore`) is unit-tested, and the API's no-Redis boot path is smoke-tested; the adapter itself is typechecked/reviewed only and labeled unverified in code and docs.
- **Playwright E2E was NOT executed locally**: the Chromium browser download timed out in this environment (two attempts in the MVP sprint; not retried here per instructions). The spec + config are authored and the CI `e2e` job installs browsers and runs them — itself unverified until the repo is pushed to GitHub. Labeled *scaffolded, pending CI verification*.
- Prisma schema gaps the adapter documents in-code: `Donation` has no column for the domain audit `history` (recoverable from the outbox stream; a follow-up migration should add it), and `Notification` has no `donationId` column (the link lives in the outbox payload).
- The API loads the app-services ESM build via Node ≥22 `require(esm)`; engines and CI are pinned to Node 22 accordingly.
- No deployment, no GitHub remote — no GitHub auth was available. Repo is a local git repo only; CI has never run on GitHub.

## Acceptance criteria progress

| Criterion | Status |
|---|---|
| End-to-end donor→recipient workflow | **Done over real HTTP** — Nest API delegates to the tested WorkflowService; `scripts/smoke-test.sh` proves the full flow incl. idempotent replay and cross-org 403 (in-memory persistence); DB-backed run pending live Postgres |
| Data persists across restarts | Schema/migrations + Prisma adapter ready and selectable; not yet exercised against live Postgres |
| Background jobs retry/failure behavior | **Proven at the worker-core level** (retry-then-success, FAILED visibility, donation state unaffected); BullMQ live run pending a Redis server |
| Tests cover business rules & security boundaries | Yes — domain (16) + app-services (40) suites, incl. JWT tamper/expiry, bcrypt login failures, and cross-org authorization; HTTP-level authorization/idempotency covered by the smoke test |
| CI runs tests | Workflow covers domain, app-services, API typecheck + build + HTTP smoke test, web build, Playwright E2E; runs on first GitHub push (not yet pushed) |
| Clean checkout reproduces dev env | Domain + app-services + API (memory adapter): yes, no infra needed (`npm run build:api`, `bash scripts/smoke-test.sh`). Full stack: via Compose, unverified locally |
| Demo + setup instructions | README quick start present; API boots locally with credential login for seeded synthetic users; hosted demo not yet available |

## Next tasks

1. Run the workflow against live Postgres (Docker Compose, `STORE_ADAPTER=prisma`) and add a `Donation.history` migration
2. Run the BullMQ adapter against a live Redis; surface failed jobs in a small admin view
3. Push to GitHub so CI (incl. the new smoke-test step and Playwright E2E with installed browsers) runs for the first time; fix whatever it surfaces
4. Deploy (managed Postgres/Redis + app platform) once credentials are available
