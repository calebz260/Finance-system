# Architectural decisions

Each entry records what was decided, why, and what it costs. Decisions that reverse an
earlier one supersede it explicitly rather than quietly replacing it.

---

## ADR-001: Money is `Decimal`/`NUMERIC(14,2)` end to end, never floating point

**Status:** accepted (Phase 0)

Monetary values are arbitrary-precision decimals in the application (`decimal.js`, via the
`Money` value object) and `NUMERIC(14, 2)` in PostgreSQL. Rounding is round-half-up
everywhere, applied at construction, with no per-call-site override. Money crosses the API
boundary as a **string**.

**Why.** IEEE-754 doubles cannot represent 0.1 exactly; summing charges in a float drifts,
and a school ledger that is off by a few francs is not trustworthy. A JSON _number_ would be
re-parsed as a double by any client, so the string form is what keeps precision intact
across the wire. Fixing the scale at 2 rather than 0 keeps the schema consistent if a second
currency is ever needed, even though RWF subunits are not used day to day.

**Cost.** Slightly more ceremony: no `+` on amounts, and `Money.allocate` must be used when
splitting a total so rounding remainders are preserved rather than lost.

**Verified by** `shared/tests/money.test.ts` and a real-engine check in
`backend/tests/integration/database.test.ts`.

---

## ADR-002: Multi-school from day one

**Status:** accepted (Phase 0)

Every core table carries a `school_id`, and scoping is applied by shared repository helpers
rather than trusted to individual queries.

**Why.** One column and one scoping layer now; a data migration across live financial
records later. The specification is explicit that this must not be skipped because only one
school uses the system at launch. Enforcing it in the repository layer — not the UI — is what
makes "a bursar cannot read another school's data" true rather than merely invisible.

**Cost.** Every query carries a scope argument, and the scoping helper must be used
consistently. Phase 1 introduces the column; Phase 2 binds the acting user's school into the
request context.

---

## ADR-003: Manual/offline payment verification is a first-class workflow

**Status:** accepted (Phase 0, implemented in Phase 5)

The manual path (bank slip, cash, SACCO remittance) gets the same rigour as the
provider-processed path: its own entities, states, verification step, statement import and
reconciliation.

**Why.** The problem this system exists to solve _is_ manual fee-slip verification. Two of
the three named channels — Zigama CSS and Umwarimu SACCO — are very likely
statement-reconciled rather than live-API, so the manual path may carry most of the real
transaction volume. Treating it as an exception path would mean building the wrong system.

**Consequence.** A manual claim never touches the ledger until an authorised bursar confirms
it against a statement, and the confirming user should not be the submitting user.

---

## ADR-004: Prisma 7 with the `pg` driver adapter

**Status:** accepted (Phase 0)

PostgreSQL through Prisma 7, connected via `@prisma/adapter-pg`. The connection URL lives in
`backend/prisma.config.ts` for CLI commands and is supplied to the adapter at runtime.

**Why.** Prisma 7 removed `url` from `datasource` and requires a driver adapter, so this is
the supported shape rather than a preference. It has a genuine benefit: the connection pool
is configured explicitly in application code (bounded `max`, idle recycling, fail-fast
connect timeout) instead of through connection-string parameters, and no stray schema file
can point a migration at the wrong database.

**Cost.** Generated client output lives in `backend/src/generated/` and is git-ignored, so
`prisma generate` must run before typecheck, test and build. The `pre*` npm hooks do this
automatically; CI does it as an explicit step.

---

## ADR-005: Timestamps stored in UTC, displayed in Africa/Kigali

**Status:** accepted (Phase 0)

Every timestamp is stored as `timestamptz` in UTC. Conversion to Africa/Kigali (UTC+2, no
DST) happens only in the presentation layer, in one module (`frontend/src/lib/format.ts`).

**Why.** Receipts, reports and audit logs must agree on what time something happened. Storing
local time invites ambiguity and makes cross-checking a bank statement harder. Converting in
exactly one place means a receipt and an audit entry cannot disagree.

**Verified by** an integration test asserting the database session time zone is UTC.

---

## ADR-006: Type-aware linting is on

**Status:** accepted (Phase 0)

ESLint runs with `recommendedTypeChecked` and `projectService`, including
`no-floating-promises` and `no-misused-promises`.

**Why.** The rules it unlocks catch the faults that actually matter here: an un-awaited
database write, an async handler passed where a sync one is expected, a `Decimal` implicitly
stringified into a template. Those show up as a wrong balance, not as a crash, which makes
them the expensive kind of bug.

**Cost.** Linting is slower, and generated code must be excluded.

---

## ADR-007: Validation output goes on `req.valid`, not over `req.body`

**Status:** accepted (Phase 0)

`validate(schemas)` attaches parsed and coerced data to `req.valid`, read through
`validated<T>(req)`.

**Why.** Express 5 exposes `req.query` through a getter, so overwriting it is not reliable;
and keeping the raw input intact means later middleware can still see exactly what the client
sent. All declared parts are validated before failing, so a user gets every field problem at
once instead of discovering them one reload at a time. If the middleware is ever missed on a
route, `validated()` throws immediately rather than letting `undefined` travel into a service.

---

## ADR-008: One `DataState` component owns loading, error, empty and success

**Status:** accepted (Phase 0)

**Why.** "Loading/error/empty states on every page" is a requirement that decays if each page
implements it by hand. Centralising it means a screen cannot ship missing one. It also keeps
an important distinction visible: "no payments recorded today" (empty) is normal, and a bursar
must be able to tell it apart from "payments failed to load" (error).

---

## ADR-009: Money formatting, but never money arithmetic, in the browser

**Status:** accepted (Phase 0)

The web client may construct and format `Money`; it must never derive a balance.

**Why.** A balance computed in two places will eventually disagree in one of them, and the
server is the only side that can be trusted or audited. `formatMoney` renders an invalid
figure as an em dash rather than throwing, so one malformed value cannot blank an entire
payments table.

---

## ADR-010: A separate test database, and tests that fail loudly without it

**Status:** accepted (Phase 0)

Integration tests use `TEST_DATABASE_URL`, run serially, and are not skipped when PostgreSQL
is absent.

**Why.** A suite that silently skips the database is worse than no suite: it reports green
while proving nothing. Running serially prevents suites from interleaving transactions and
truncations against the same schema. The separate database means a test reset can never
truncate development data.

---

## ADR-011: Sessions are server-side, and refresh tokens rotate with reuse detection

**Status:** accepted (Phase 2)

An access token is a short-lived JWT that names a **session row**. Every authenticated request
re-reads that row, the account status and the current permissions. The refresh token is not a
JWT at all: it is 256 bits of opaque randomness, stored only as a SHA-256 hash, rotated on every
use, and a token presented after it has been consumed revokes the entire session.

**Why.** A self-contained token is only revocable by waiting for it to expire. In a system where
a role decides who can write off a fee or verify a payment, "your suspension takes effect within
fifteen minutes" is not an acceptable answer. Re-reading the session costs one indexed query and
buys immediate revocation, authoritative permissions, and a smaller token.

Reuse detection is the strict choice on purpose. When a consumed refresh token reappears, the
request cannot distinguish a client retry from a theft — so the session collapses. The
alternative, quietly issuing a new token, lets a thief ride along indefinitely: they refresh, the
victim refreshes, and both keep working. Collapsing turns a silent compromise into a visible one
plus an audit entry.

**Cost.** A database read per request, and an occasional unexplained sign-out for a user whose
client genuinely double-submitted a refresh. The client collapses concurrent renewals onto one
request precisely to keep that rare.

**Verified by** `backend/tests/integration/auth-session.test.ts` and
`frontend/src/lib/api-client.auth.test.ts`.

---

## ADR-012: MFA is enforced by token audience, not by a flag

**Status:** accepted (Phase 2)

A correct password for a role that requires MFA yields an intermediate token whose JWT
**audience** is `sfs:mfa-challenge`, not `sfs:access`. The authentication middleware only accepts
the access audience. A session records whether it satisfied MFA, and that cannot be upgraded in
place — enabling a second factor ends every existing session.

**Why.** If step one of two-factor authentication returned something the API would accept, MFA
would be advisory: anyone who noticed could skip step two. Separating the audiences makes "this
credential is not a session" a property of the token rather than a check somebody has to
remember to write. Requiring MFA is also evaluated against the roles held _now_, so granting
someone the Bursar role does not leave them with a single-factor session.

**Cost.** Three token kinds instead of one, and a user who enrols voluntarily is signed out at
the end of enrolment rather than continuing seamlessly.

**Verified by** `backend/tests/unit/token.service.test.ts` and the MFA sections of
`backend/tests/integration/auth-login.test.ts`.

---

## ADR-013: A password-reset link goes through a delivery port, never into a response or a log

**Status:** accepted (Phase 2)

`PasswordResetDelivery` is an interface. Until Phase 6 supplies a notification channel, the
adapter logs the link **in development only** and, in every other environment, logs an error
recording that a reset was requested and nothing was sent.

**Why.** The reset token is a credential for the account. Returning it to the caller of
`POST /auth/password/reset-request` would let anyone reset anyone's password by asking; writing
it to a production log would place a live credential in every log sink and backup downstream.
Defining the seam now means the flow is complete and testable today — the token is minted,
hashed, stored, expired and consumed exactly as it will be in production — and only the last hop
changes later.

**Cost.** Password reset is not self-service in production until Phase 6. Until then an
administrator unlocks or reissues accounts, which is the status quo rather than a regression.

**Verified by** `backend/tests/integration/auth-password.test.ts`, which swaps in a recording
adapter.

---

## ADR-014: Nobody may change the roles on their own account

**Status:** accepted (Phase 2)

`user.assign_role` permits granting and revoking roles on _other_ accounts only, and never a role
ranked above the caller's own.

**Why.** The rank rule alone is not sufficient, and the gap is not obvious. Role ranks order
privilege, but they do not nest permissions: a School Administrator (rank 80) does not hold
`payment.reverse`, while a Finance Manager (rank 70) does. A rank-only rule would therefore let a
School Administrator grant themselves the _lower_-ranked Finance Manager role and acquire a
permission they were deliberately not given. Refusing self-assignment outright means every grant
is an act by a second person, which is the property the separation of duties actually depends on.

**Cost.** A school with exactly one administrator cannot change its own roles and needs the
Super Administrator. That is the correct trade: a single account able to grant itself anything is
not an administrator, it is a superuser.

**Verified by** the role-assignment cases in `backend/tests/integration/authorization.test.ts`.

---

## ADR-015: A bulk import validates in full, previews, and then applies all or nothing

**Status:** accepted (Phase 3)

`POST /students/import/preview` parses and validates an uploaded file and writes nothing. It
reports every problem it found, each against the row number the spreadsheet shows.
`POST /students/import` re-validates and applies the file in a single transaction; by default
a file with any problem imports nothing, and importing only the valid rows is an explicit
opt-in.

**Why.** The file this feature exists for is the school's real one: about a thousand students,
typed by several people over several years, with inconsistent dates, phone formats and
spellings. Two properties follow from that.

Stopping at the first bad row would mean fixing a thousand-row file one error per upload, so
validation collects everything. And a partially applied import is worse than a failed one: the
registrar cannot tell which rows landed, and re-running duplicates the ones that did — with a
Student ID allocated to each, which is the one thing that must never be issued twice. One
transaction makes "try again" always safe.

Re-validating at commit rather than trusting the preview means no server-side state between
the two calls, and no window in which the structure changes underneath a stale preview.

**Cost.** The file is uploaded and parsed twice. At five megabytes and a hundred milliseconds
that is a fair price for not having to reconcile a half-applied import.

**Verified by** `backend/tests/integration/student-import.test.ts`, including a 1,000-row file.

---

## ADR-016: An imported guardian is recognised by normalised phone number

**Status:** accepted (Phase 3)

Guardian phone numbers are normalised to `+250…` before matching, and a guardian already
present — in the file or in the database — is linked rather than created again.

**Why.** Four siblings in one file carry the same parent on four rows, written `0788123456`,
`+250 788 123 456` and `250788123456`. Creating a guardian per row would give that parent four
records, and the parent portal in Phase 5 would then show each of them one child while the
school believes it has one contact. The phone number is the only field these files reliably
carry and reliably repeat, which makes it the practical identity.

**Cost.** Two guardians who genuinely share a household line are merged into one. That is the
right default for a fee system — the number is how the school reaches whoever pays — and the
link can be corrected afterwards, whereas a duplicated parent is discovered only when somebody
cannot see their child.

**Verified by** the sibling and pre-existing-guardian cases in
`backend/tests/integration/student-import.test.ts`.

---

## ADR-017: Import files are parsed in memory and never written to disk

**Status:** accepted (Phase 3)

Uploads are held in memory by `multer.memoryStorage`, capped at 5 MB and one file, parsed, and
discarded when the request ends.

**Why.** Phase 5 owns file handling: where uploads live, how long they are kept, who may read
them, and malware scanning for proof-of-payment documents. Writing import files to disk now
would establish a storage convention before any of those decisions were made, and Phase 5
would have to undo it. Parsing in memory keeps the feature complete without pre-empting that
design, and an import file is transient by nature — it is a means of getting data in, not a
record the school needs to keep.

**Cost.** A hard size limit, and no server-side retry of a failed upload. Both are acceptable
for a file that is re-exported from a spreadsheet in seconds.

---

## ADR-018: Registration creates the student and the first enrolment together

**Status:** accepted (Phase 3)

`POST /students` takes the placement in the same body and writes both, or neither.

**Why.** An enrolment is what ties a student to a year, a programme, a level and a class, and
every later charge is computed against it. A student row without one is invisible to fee
calculation, class lists and every report — and nothing surfaces the omission, because the
record looks complete. Making placement a second request means it is a second request that
sometimes does not happen.

**Cost.** A student cannot be recorded before their placement is known. In practice a school
registers a student _into_ a class, so this matches the actual paperwork; a student whose class
is undecided can be enrolled at level with the class left unset.

**Verified by** the registration cases in `backend/tests/integration/students.test.ts`.

## ADR-019: Two fee structures charging one category refuse the run

**Status:** accepted (Phase 4)

Applicability is a filter, not a hierarchy: a fee structure matches a student when every field it
specifies matches their enrolment, and a null field does not narrow. Several structures may
therefore match one student, and they all contribute. If two of them would charge the same fee
category for the same period, charge generation aborts before writing anything and names the
category, the structures and the number of students affected.

**Why.** The alternative designs are worse in different directions. Charging both silently
doubles a family's tuition and looks correct in every individual record. "Most specific wins"
avoids that, but introduces precedence rules — class beats level beats programme — which have to
be held in someone's head to predict what a run will do, and which make "why was this student
charged less?" a question with a non-obvious answer years later. Refusing keeps the model
additive and with no precedence to misread, and an overlap is nearly always a misconfiguration
rather than an intention.

**Cost.** A school that genuinely wants one category billed by two structures cannot express it.
The escape hatch is an ad-hoc charge, which carries a mandatory reason.

**Verified by** the overlap cases in `backend/tests/integration/fees.test.ts`.

## ADR-020: The duplicate-charge key is the fee-structure line

**Status:** accepted (Phase 4)

A student may hold only one live charge per fee-structure item per period. Enforced by two partial
unique indexes rather than one, because the key branches on whether the charge is termly
(`term_id` set) or annual (`term_id` null), and PostgreSQL treats nulls as distinct — a single
index over the nullable column would silently permit duplicates of every annual charge.

Both indexes exclude voided rows, so a charge raised in error can be voided and the correct one
raised in its place. Both leave ad-hoc charges unconstrained, since their `fee_structure_item_id`
is null and nulls do not conflict.

**Why.** Re-running generation is the common operation — a registrar adds three late students and
runs it again — so it has to be safely idempotent. Keying on the category instead would be
stricter and would block a legitimate second charge; keying on the whole structure would be
looser and would miss a duplicate arriving from two structures.

**Cost.** A genuine second charge in a category a student already holds must be raised ad hoc,
where it carries a mandatory note. That is the intended friction.

**Verified by** the idempotency and re-raise cases in `backend/tests/integration/fees.test.ts`.

## ADR-021: A negative balance is reported as a credit, never as a negative debt

**Status:** accepted (Phase 4)

`outstanding` is floored at zero. When the ledger nets in the family's favour the surplus appears
in `creditBalance` instead. Exactly one of the two is ever non-zero.

**Why.** A negative number in a money column has to be interpreted, and different readers
interpret it differently — a report that sums outstanding balances across a school would quietly
net one family's overpayment against another family's debt and understate what is owed. Naming
the credit makes it a thing that can be reported on, refunded in Phase 5, and cleared, rather
than a sign convention.

**Cost.** Two fields where one might do, and both must be read to know the position.

**Verified by** the credit-balance cases in `backend/tests/unit/balance.test.ts` and
`backend/tests/integration/fees.test.ts`.

## ADR-022: The financial ledger is the only source of a balance

**Status:** accepted (Phase 4)

Charges, discounts, scholarship awards, waivers and adjustments are _business records_. None of
them is ever summed to produce a balance. Each posts a row to `financial_entries` when it takes
effect, and a balance is `SUM(DEBIT) − SUM(CREDIT)` over those rows and nothing else.

A record posts its entry at the moment it becomes real: a charge when raised, relief when
approved. Rejected relief posts nothing. The ledger is insert-only — an entry that turns out to
be wrong is never edited or deleted, an opposing entry is posted and linked through
`reversal_of_entry_id`, so a reversal nets itself out arithmetically and reads as two facts.

**Why.** A balance derived from five tables has five chances to double-count, and every relief
type added later adds a term to the formula and another place to get it wrong. Entries make the
formula closed. It also makes the Phase 5 seam trivial: a payment is a `PAYMENT`-sourced CREDIT,
a new value in an existing set, and not a change to how money is counted.

The unique indexes that permit only one opening entry per source record are what make
double-posting structurally impossible rather than a rule the service has to remember — a retried
request or two concurrent approvals hit the constraint.

**Cost.** Two writes where one would do, and an extra table to reason about. A business record
whose entry failed to post would be invisible in the balance, so every posting happens inside the
same transaction as the record it belongs to.

**Verified by** `backend/tests/unit/balance.test.ts` and the ledger cases in
`backend/tests/integration/fees.test.ts`.
