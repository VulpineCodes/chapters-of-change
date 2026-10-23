# Architecture

## Why a separate domain package

`packages/domain` holds every business rule — the donation state machine, RBAC policy, search/pagination, idempotency, and the outbox dispatcher — with no framework imports. NestJS controllers and Next.js pages call into it. Payoff: the rules that matter most are testable with Vitest in under a second, with no database, Redis, or server running, and there's exactly one implementation of each rule instead of a copy in the API and another in tests.

## Donation lifecycle state machine

```
DRAFT ──► PENDING_APPROVAL ──► APPROVED ──► IN_TRANSIT ──► DELIVERED ──► COMPLETED
  │              │                │
  └──────────────┴────► REJECTED / CANCELLED (terminal, where allowed)
```

Transitions are an explicit allow-list (`TRANSITIONS` in `donation.ts`). Anything not listed throws `IllegalTransitionError`. Every transition appends to an audit history (actor, timestamp, reason). Terminal states (`REJECTED`, `COMPLETED`, `CANCELLED`) accept no outgoing transitions. This matters because "just update the status column" is how a delivered donation ends up approved again, or a rejected request quietly ships.

## Transactional outbox — why it earns its place

Problem: when a donor approves a donation, two things must happen — the status change persists, and the organization gets notified. Doing them naively gives two failure modes: crash after the DB write and the notification is lost; send first and the notification announces a change that rolled back.

Solution: the workflow service writes the status change **and** an `OutboxEvent` in the same store transaction (the Prisma adapter's `$transaction` is the production boundary; the verified in-memory adapter models the same contract). A worker dispatches pending outbox events, retrying with exponential backoff (100ms, 200ms, 400ms…), and marks them `DELIVERED` or, after exhausting attempts, `FAILED` with the last error preserved for inspection. Delivery is at-least-once, so consumers must be idempotent — which is why donation creation also accepts an idempotency key backed by a unique DB constraint (the in-memory `IdempotencyStore` in the domain package models the same contract for tests).

This is not decoration: notifications are a core product promise ("you'll know when your request is approved"), and the outbox is the standard way to make DB state and messaging agree. The domain dispatcher takes an injectable sleeper so backoff is tested deterministically without real delays.

## Queues (BullMQ)

Delivery semantics live in a queue-agnostic core (`NotificationWorkerCore` in `packages/app-services`): given an outbox event it delivers a notification, retries with exponential backoff (100ms, 200ms, …), and after the max attempts moves the event to `FAILED` with the last error preserved. That core is unit-tested offline. The BullMQ adapter (`apps/api/src/notifications/bullmq.adapter.ts`) wires the same core to a real Queue/Worker — one `chapters-notifications` queue, a repeatable poll job that turns PENDING outbox rows into `deliver` jobs whose jobId is the outbox event id (natural dedup), BullMQ's own retries left at 1 so the core owns the policy. The adapter only starts when `REDIS_URL` is set; without Redis the API boots with the worker disabled (stated in the boot log and `/health`), and it is labeled **unverified** — this repo's build environment has no Redis to run it against.

## RBAC

Four roles: `DONOR`, `ORG_ADMIN`, `ORG_MEMBER`, `ADMIN`. Policy is a set of pure functions (`canApproveDonation`, `canEditListing`, …), not scattered `if (user.role === …)` checks. Notable rules: only the owning donor (or admin) can approve/reject; only org roles can request; listing edits are owner-only; org members act only within their own organization. The NestJS `RolesGuard` handles coarse route-level roles; fine-grained ownership checks happen in `WorkflowService` using these same functions. The Nest listings/donations services are thin adapters that delegate to `WorkflowService` — since the hardening sprint there is exactly one implementation of the workflow, and the API's HTTP surface was smoke-tested against it end to end (`scripts/smoke-test.sh`). Authorization is always enforced server-side — the UI merely hides what the API would reject anyway.

## Security notes

- All inputs validated (class-validator + global `ValidationPipe` with whitelist); Prisma parameterizes queries (no string-built SQL).
- Passwords are bcrypt-hashed (`bcryptjs`, cost 10) at registration and verified at login by `CredentialAuthService`; plaintext is never stored or logged, login failures return a generic 401 for both unknown email and wrong password (with a dummy-hash comparison to blunt timing leaks), and successful logins issue the HS256 JWT. JWT secret comes from `.env`, never committed (see `.env.example`). A `/auth/dev-token` endpoint exists for local demos only and is labeled as such in code and docs.
- Authorization failures tested explicitly, including cross-organization and non-owner cases.
- Request correlation ids (`x-request-id`) propagated for log tracing; structured logs planned via the bootstrap logger.
- Seed data is synthetic and labeled as such; no real user data anywhere in the repo.

## Runtime wiring

The API selects its persistence adapter with `STORE_ADAPTER`: `memory` (default) runs the verified in-memory store seeded with synthetic data — this is what the test suites and the HTTP smoke test exercise — while `prisma` selects the PostgreSQL adapter, which is written and typechecked but **unverified** until run against a live database. The application layer ships as a built ESM package (`packages/app-services/dist`, via `tsconfig.build.json`) that the CommonJS NestJS API loads through Node ≥22's `require(esm)` support; `npm run build:api` builds domain → app-services → api in dependency order.

## Data model

PostgreSQL via Prisma: `User`, `Profile`, `Organization`, `Listing`, `DonationRequest`, `Donation`, `OutboxEvent`, `Notification`. Enums in the schema mirror the domain types exactly, so the compiler and the database agree on the lifecycle. `Donation.idempotencyKey` and `OutboxEvent (status, createdAt)` are indexed/unique for the patterns above.
