# Chapters of Change

A platform that connects people donating used comic books and manga with schools, libraries, and community organizations that want them.

I grew up in Lagos and have loved art, comics, and storytelling for as long as I can remember. Most donation drives focus on essentials, and those matter. I kept thinking about the other thing a kid can be given: a story that opens up a world. This project builds the logistics for that. It is a personal motivation, not a claim of impact. Everything in this repo is synthetic demo data. There are no partner organizations and no real donations behind it yet.

```
PENDING_APPROVAL --> APPROVED --> IN_TRANSIT --> DELIVERED --> COMPLETED
       |                |
       +--> REJECTED    +--> CANCELLED (terminal, where allowed)
```

A request starts as a draft inside the workflow code and is submitted to `PENDING_APPROVAL` in the same transaction, so the first status anyone sees is `PENDING_APPROVAL`. `REJECTED`, `COMPLETED`, and `CANCELLED` accept no further transitions.

## What it does

- Donors list comics and manga with condition, language, genre, and age suitability.
- Organizations search, filter, and request donations.
- A strict donation lifecycle governs every request. Illegal transitions return 409.
- Donation requests are idempotency keyed. Resubmitting with the same key, even concurrently, returns the original donation instead of creating a duplicate. Over HTTP, the key travels in the `Idempotency-Key` header.
- Status changes and notification records are written in the same store transaction through a transactional outbox. Delivery is a separate step: the tested worker core retries with exponential backoff and marks exhausted events `FAILED` with the error preserved. In the default local boot the worker is disabled and outbox events stay `PENDING` (see Limitations).
- Access is role based throughout. Organizations request, only the owning donor approves, and cross organization access is denied. The workflow layer enforces this, and the HTTP smoke test exercises the 403 cases.
- Credential auth uses bcrypt hashed passwords and HS256 JWTs implemented with Node's built-in `crypto`, with no JWT library. A dev only token endpoint exists for local demos and is labeled as such in code, Swagger, and `.env.example`.
- Donor and organization dashboards render the two sides of the workflow.

## How it is built

TypeScript throughout. Next.js for the web app. NestJS with OpenAPI for the API. PostgreSQL with Prisma for the schema and migrations. Redis with BullMQ for the notification adapter. Vitest for unit and integration tests, Playwright for browser tests, Docker Compose for the full stack.

The business rules live in `packages/domain`, a framework free TypeScript package with zero runtime dependencies. The application layer in `packages/app-services` orchestrates those rules: the workflow service, credential auth, the notification worker core, and repository interfaces with in-memory and Prisma adapters. The full donor to recipient workflow is integration tested without a database. The NestJS API is a thin adapter over these packages. Its listings and donations services delegate to the same tested `WorkflowService`. The in-memory store is the default runtime adapter (`STORE_ADAPTER=memory`). The Prisma adapter is selectable with `STORE_ADAPTER=prisma` and has never run against a live database (see Limitations).

The web app does not import the domain package. It talks to the API over HTTP.

## Quick start

```bash
# Fast test suites, no database needed: domain (16 tests) + app-services (40 tests)
npm install -w @chapters/domain -w @chapters/app-services
npm test

# Typechecks for the two packages covered by the root script
npm run typecheck
```

```bash
# API: build in dependency order (domain, app-services, api), then boot.
# Boots WITHOUT Postgres or Redis: in-memory store, worker disabled (logged).
npm install -w @chapters/api
npm run build:api
node apps/api/dist/main.js
```

```bash
# Credential login for the seeded SYNTHETIC users (dev only, see .env.example)
curl -X POST localhost:4000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"donor@example.com","password":"synthetic-donor-pass"}'
curl localhost:4000/health        # store adapter + notification worker status
curl localhost:4000/docs          # OpenAPI / Swagger UI
```

```bash
# Full HTTP smoke test: boots the API and drives the donor to recipient
# workflow with curl (idempotency replay, cross-org 403, every status
# transition, login success and failure). Exits non-zero on any mismatch.
bash scripts/smoke-test.sh
```

```bash
# Browser tests: build both apps first, then install browsers and run.
# 5 tests passed locally on 2026-10-28. They cover page rendering and
# navigation only, not workflow transactions.
npm run build:api
cd apps/web && npm run build && cd ../..
cd apps/web && npx playwright install chromium && npm run test:e2e
```

```bash
# Full stack (requires Docker; Compose has not been run in this environment)
cp .env.example .env
docker compose up --build
# Web: http://localhost:3000  API + docs: http://localhost:4000/docs
# Note: Compose provisions Postgres and Redis but does not set
# STORE_ADAPTER, so the API still boots on the in-memory store.
# The Prisma path needs `npx prisma generate` and a migration run first,
# and it has never been exercised against a live database.
npx prisma migrate deploy
```

## Layout

```
apps/api/               NestJS API: JWT auth + RBAC guard, credential login,
                        listings/donations delegating to WorkflowService,
                        BullMQ notification adapter, health
apps/web/               Next.js app: home, listings search, donor and org
                        dashboards, Playwright E2E
packages/domain/        State machine, RBAC, search/pagination, idempotency, outbox
packages/app-services/  Workflow service, credential auth (bcrypt),
                        notification worker core, repository adapters
                        (in-memory verified, Prisma unverified), auth issuance
prisma/                 Schema, hand-checked initial migration, synthetic seed
scripts/                smoke-test.sh, the end-to-end HTTP verification
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for design decisions and [STATUS.md](./STATUS.md) for what has been verified and what has not.

## Verification

| Check | Result |
|---|---|
| `npm test` (domain + app-services) | 56 passed, 0 failed (16 + 40), run 2026-10-28 |
| Typechecks (domain, app-services, API, web) | All exit 0, run 2026-10-28 |
| `npm run build:api` | Exit 0, run 2026-10-28 |
| Web build (`next build`) | Exit 0, 5 routes, run 2026-10-28 |
| HTTP smoke test (`scripts/smoke-test.sh`) | Passed, run 2026-10-28 |
| Playwright E2E (`apps/web`, 5 tests) | 5 passed, first local run 2026-10-28; page rendering and navigation only |
| GitHub Actions CI | Not run. The workflow file exists locally only and is not on the public branch (see Limitations) |

## Limitations

What has been verified is listed above and in STATUS.md. What has not:

- The Prisma adapter has never run against a live Postgres. There was no database or Docker in the build environment. `STORE_ADAPTER=prisma` is wired and fails fast without `DATABASE_URL`, but it stays selectable and unverified. The verified persistence adapter is the in-memory one, and state resets on restart. The Prisma seed file (`prisma/seed.ts`) uses a placeholder password hash and has no configured seed runner, so it cannot be used as written; the working seed is the in-memory one in `packages/app-services/src/seed.ts`.
- The BullMQ adapter has never run against a live Redis. Its queue agnostic core is the tested part. The adapter itself is typechecked and reviewed only.
- Docker Compose and the Dockerfiles have not been run. The Dockerfiles were bumped to Node 22 during this audit to match the `engines` requirement, but that change is untested.
- The GitHub Actions workflow (`.github/workflows/ci.yml`) exists in this local repo only. A read-only check of the public branch on 2026-10-28 found no `ci.yml` there, and the public branch is at snapshot `7741b479` from Oct 23. CI has never run. Do not describe CI as configured or working until the workflow file is on the public branch and a run has passed.
- There is no deployment and no live demo. The web app runs locally only.
