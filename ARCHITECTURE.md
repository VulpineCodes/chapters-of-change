# Architecture

## Why a separate domain package

`packages/domain` holds the business rules: the donation state machine, RBAC policy, search and pagination, idempotency, and the outbox dispatcher. It has no framework imports. The API calls into it through `packages/app-services`. The web app does not import it; it talks to the API over HTTP. Keeping the rules in one place means the rules that matter most run under Vitest with no database, Redis, or server running, and there is exactly one implementation of each rule instead of a copy in the API and another in tests.

## Donation lifecycle state machine

```
DRAFT --> PENDING_APPROVAL --> APPROVED --> IN_TRANSIT --> DELIVERED --> COMPLETED
  |              |                |
  +--------------+----------------+--> REJECTED / CANCELLED (terminal, where allowed)
```

Transitions are an explicit allow list (`TRANSITIONS` in `donation.ts`). Anything not listed throws `IllegalTransitionError`. Every transition appends to an audit history (actor, timestamp, reason). Terminal states (`REJECTED`, `COMPLETED`, `CANCELLED`) accept no outgoing transitions.

In practice, a request is created as `DRAFT` and immediately submitted to `PENDING_APPROVAL` inside the same store transaction in `WorkflowService.requestDonation`, so `PENDING_APPROVAL` is the first status stored and visible. `DRAFT` never appears as a stored status on its own. The audit history records both steps.

The full allow list, from `packages/domain/src/donation.ts`:

```ts
DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
APPROVED: ['IN_TRANSIT', 'CANCELLED'],
REJECTED: [],
IN_TRANSIT: ['DELIVERED', 'CANCELLED'],
DELIVERED: ['COMPLETED'],
COMPLETED: [],
CANCELLED: [],
```

## Transactional outbox and notification delivery

When a donor approves a donation, two things need to happen: the status change persists, and the organization gets notified. Done naively, there are two failure modes. A crash after the database write loses the notification. Sending first announces a change that may roll back.

The workflow service writes the status change and an `OutboxEvent` in the same store transaction. In the Prisma adapter, `$transaction` is the production boundary. In the verified in-memory adapter, the store's `transaction` method models the same contract. That pairing is what has been tested. It does not by itself deliver anything.

Delivery is a separate step, handled by `NotificationWorkerCore` in `packages/app-services`. The core is queue agnostic: given an outbox event, it calls an injected deliver function, retries with exponential backoff starting at 100ms and doubling (100ms, 200ms, 400ms), up to 3 attempts by default, and after exhausting attempts moves the event to `FAILED` with the last error preserved. `processPending` drains a store's outbox and persists final states. The core is unit tested offline with an injectable sleeper, so backoff delays are asserted without real waiting. A failing notification handler never rolls back donation state.

The BullMQ adapter (`apps/api/src/notifications/bullmq.adapter.ts`) wires that core to a real Queue and Worker: one `chapters-notifications` queue, a repeatable poll job every 30 seconds that turns `PENDING` outbox rows into `deliver` jobs whose job id is the outbox event id, and BullMQ's own retries left at 1 so the core owns the policy. The adapter only starts when `REDIS_URL` is set. Without Redis, the API boots with the worker disabled (stated in the boot log and in `GET /health`), and outbox events remain `PENDING` in the store. The adapter is labeled unverified: this environment has no Redis to run it against, and it has never run against a live Redis anywhere.

Delivery through the tested core is at least once, so consumers must tolerate duplicates. Donation creation accepts an idempotency key backed by a unique database constraint in the Prisma schema (the in-memory `IdempotencyStore` in the domain package models the same contract for tests, with a keyed mutex serializing the check-then-create section).

The domain package also contains an in-memory `OutboxDispatcher` with the same retry shape. It is the older dispatcher used by domain level tests. The runtime path uses `NotificationWorkerCore`, not this dispatcher. See STATUS.md for which tests cover which module.

## RBAC

Four roles: `DONOR`, `ORG_ADMIN`, `ORG_MEMBER`, `ADMIN`. Policy is a set of pure functions (`canApproveDonation`, `canEditListing`, and others in `packages/domain/src/rbac.ts`), not scattered role checks. The rules:

- Only the owning donor, or an admin, can approve or reject a donation. Organization roles cannot approve, including an organization approving its own request.
- Only organization roles (or an admin) can request a donation. Donors cannot request.
- Listing edits are owner only, except admins.
- Organization members act only within their own organization. Cross organization view, cancel, and complete attempts are denied.
- Donation viewing is limited to the owning donor, members of the requesting organization, and admins.

The NestJS `RolesGuard` handles coarse route level roles and builds `req.user` only from verified Bearer token claims. It returns 401 when there is no valid token and 403 when the role is insufficient. Fine grained ownership checks happen in `WorkflowService` using the same domain policy functions. The Nest listings and donations services are thin adapters that delegate to `WorkflowService`, so there is exactly one implementation of the workflow. Authorization is enforced server side. The UI only hides what the API would reject anyway.

## Security notes

- All inputs are validated with class-validator and a global `ValidationPipe` with whitelist enabled. Prisma parameterizes queries, so no SQL is built from strings.
- Passwords are bcrypt hashed (`bcryptjs`, cost 10) at registration and verified at login by `CredentialAuthService`. Plaintext is never stored or logged. Login failures return a generic 401 for both unknown email and wrong password, and the unknown email path runs a dummy bcrypt comparison to blunt timing leaks. Successful logins issue the HS256 JWT.
- JWTs are issued and verified with Node's built-in `node:crypto` only, in `apps/api/src/auth/jwt.ts`. The algorithm is pinned to HS256 (`none` is rejected), signatures are compared with `timingSafeEqual`, and `exp` is required and enforced. The JWT secret comes from the environment and is never committed (see `.env.example`). The Vitest suites import this exact module, not a copy.
- A `/auth/dev-token` endpoint exists for local demos only and is labeled as such in code, Swagger, and docs. It must not be enabled as an authentication path anywhere real.
- Request correlation ids (`x-request-id`) are attached and propagated for log tracing. There is no structured logging setup yet; the bootstrap logger covers startup lines.
- Seed data is synthetic and labeled as such. No real user data is anywhere in the repo.

## Runtime wiring

The API selects its persistence adapter with `STORE_ADAPTER`. `memory` (the default) runs the verified in-memory store seeded with synthetic data. This is what the test suites and the HTTP smoke test exercise. `prisma` selects the PostgreSQL adapter, which is written and typechecked but unverified until run against a live database. Selecting `prisma` without `DATABASE_URL` fails fast with a clear error instead of silently falling back. Selecting it also requires a generated Prisma client (`npx prisma generate`) and a reachable database at runtime.

The application layer ships as a built ESM package (`packages/app-services/dist`, via `tsconfig.build.json`) that the CommonJS NestJS API loads through Node 22's `require(esm)` support. `npm run build:api` builds domain, then app-services, then the API, in dependency order. The engines field and CI pin Node 22 accordingly.

## Data model

PostgreSQL via Prisma: `User`, `Profile`, `Organization`, `Listing`, `DonationRequest`, `Donation`, `OutboxEvent`, `Notification`. Enums in the schema mirror the domain types. `Donation.idempotencyKey` is unique, and `OutboxEvent` is indexed on status and creation time for the polling pattern.

Known schema gaps, documented in the Prisma adapter code:

- `Donation` has no column for the domain audit `history`. Reads through the Prisma adapter return an empty history. The history is recoverable from the outbox stream, and a follow-up migration should add a history column or table.
- `Notification` has no `donationId` column. The link lives in the outbox payload, and reads through the adapter return an empty `donationId`.

Both gaps only matter on the Prisma path, which is unverified. The in-memory adapter round-trips history and notification links fully.
