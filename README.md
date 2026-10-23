# Chapters of Change

A platform that connects people who want to donate used comic books and manga with schools, libraries, and community organizations that want them.

I grew up in Lagos and have loved art, comics, and storytelling for as long as I can remember. Donations usually mean the essentials — and those matter — but I kept thinking about the other kind of thing a kid can be given: a story that opens up a world. This project is my attempt to build the logistics for that, properly. It's a personal motivation, not a claim of impact: everything in this repo is synthetic demo data, and there are no partner organizations or real donations behind it yet.

## What it does

- Donors list comics/manga with condition, language, genre, and age suitability
- Organizations search, filter, and request donations
- A strict donation lifecycle (draft → pending approval → approved → in transit → delivered → completed, with rejection/cancellation) governs every request
- Donation requests are idempotency-keyed — resubmitting (even concurrently) returns the original donation instead of creating a duplicate; over HTTP this is the `Idempotency-Key` header
- Background notifications are dispatched reliably via a transactional outbox — a status change and its notification can't silently diverge, and failed deliveries retry with backoff and stay visible as FAILED with the error preserved
- Role-based access throughout: organizations request, only the owning donor approves, and cross-organization access is denied — enforced in the workflow layer and proven over HTTP (see the smoke test below)
- Real credential auth: register/login with bcrypt-hashed passwords issuing HS256 JWTs (implemented on Node's built-in `crypto` — no JWT library), plus a clearly-labeled dev-only token endpoint for local demos
- Role-based dashboards for donors and organizations

## Stack

TypeScript throughout · Next.js (web) · NestJS + OpenAPI (API) · PostgreSQL + Prisma · Redis + BullMQ · Vitest / Playwright · Docker Compose · GitHub Actions

The business rules live in `packages/domain` — a framework-free TypeScript package with zero runtime dependencies. The application layer in `packages/app-services` orchestrates them (workflow service, credential auth, notification worker core, repository interfaces with in-memory and Prisma adapters) so the full donor→recipient workflow is integration-tested without a database. Since the hardening sprint, the NestJS API is a thin adapter over these packages: its listings/donations services delegate to the same tested `WorkflowService`, with the in-memory store as the default runtime adapter (`STORE_ADAPTER=memory`) and the Prisma adapter selectable via `STORE_ADAPTER=prisma` (unverified — see Limitations).

## Quick start

```bash
# All fast test suites (no database needed): domain (16 tests) + app-services (40 tests)
npm install -w @chapters/domain -w @chapters/app-services
npm test

# API — build in dependency order (domain → app-services → api), then boot.
# Boots WITHOUT Postgres/Redis: in-memory store, worker disabled (logged).
npm install -w @chapters/api
npm run build:api
node apps/api/dist/main.js

# Credential login for the seeded SYNTHETIC users (dev only — see .env.example)
curl -X POST localhost:4000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"donor@example.com","password":"synthetic-donor-pass"}'
curl localhost:4000/health        # store adapter + notification worker status
curl localhost:4000/docs          # OpenAPI / Swagger UI

# Full HTTP smoke test: boots the API and drives the whole donor→recipient
# workflow with curl (idempotency replay, cross-org 403, every status
# transition, login success/failure). Exits non-zero on any mismatch.
bash scripts/smoke-test.sh

# Full stack (requires Docker)
cp .env.example .env
docker compose up --build
# Web: http://localhost:3000  API + docs: http://localhost:4000/docs
npx prisma migrate deploy && npx prisma db seed   # synthetic data only

# E2E (Playwright; runs in CI — locally it needs built apps + browsers)
cd apps/web && npx playwright install chromium && npm run test:e2e
```

## Layout

```
apps/api/            NestJS API — JWT auth + RBAC guard, credential login, listings/donations
                     delegating to WorkflowService, BullMQ notification adapter, health
apps/web/            Next.js app — home, listings search, donor & org dashboards, Playwright E2E
packages/domain/     State machine, RBAC, search/pagination, idempotency, outbox
packages/app-services/  Workflow service, credential auth (bcrypt), notification worker core,
                     repository adapters (in-memory verified + Prisma unverified), auth issuance
prisma/              Schema, hand-checked initial migration, synthetic seed
scripts/             smoke-test.sh — the end-to-end HTTP verification described above
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for design decisions and [STATUS.md](./STATUS.md) for what's verified and what's next.

## Limitations

Verified in this environment (details in STATUS.md): 56 automated tests (domain 16 + app-services 40) covering the workflow, JWT security, bcrypt credential login, and the notification worker core; the API and web typecheck and build; and the compiled API passes a full HTTP smoke test of the donor→recipient workflow against the in-memory store. What is *not* done yet: the Prisma adapter has never run against a live Postgres (no database/Docker in the build environment), the BullMQ adapter has never run against a live Redis (its queue-agnostic core is the tested part), Playwright E2E is authored and CI-wired but has not executed yet (browser download unavailable locally; first run happens on GitHub push), and there is no deployment. I list these plainly rather than overselling a scaffold.
