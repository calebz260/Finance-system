# Open questions

Decisions that need confirmation from the school, the DOS, or a payment provider. Each has a
**working assumption** so development is not blocked, and each records what changes if the
answer differs. They are listed in the order they start to matter.

---

## 1. Bank of Kigali integration type — _still open; Phase 5 shipped without it_

**Question.** For the school's BK collection account, does BK offer a real-time payment
notification API or webhook, or only a fixed collection account number reconciled from
statements?

**Working assumption.** Statement-reconciled, until confirmed otherwise. **No adapter has been
written for BK**, no endpoint has been guessed and no credential is assumed. It is registered in
`provider.registry.ts` as a manual channel: a real way to pay the school, verified by a bursar
against a statement, and reconciled through the statement import.

**What Phase 5 built instead.** The provider port, one sandbox adapter that exercises the whole
provider path (signature verification, replay rejection, transactional finalisation) without a
bank, and the manual verification workflow that BK currently routes through. `GET
/payments/methods` reports `isAvailable: false` with a reason for any channel that cannot
collect, so no parent is shown a button that fails.

**Impact if answered.** Write the adapter against the documented API, register it, and flip the
channel's verification method to `PROVIDER`. Nothing in the payment domain, the ledger or the
balance changes — which is the whole point of the port.

**Who can answer.** BK corporate/business banking, for this specific account.

---

## 2. Zigama CSS and Umwarimu SACCO integration type — _still open; Phase 5 shipped without it_

**Question.** Do either expose a payment-notification API for school fees, or does the school
receive a remittance/statement to reconcile?

**Working assumption.** Statement-reconciled, through the manual verification path and the
statement import. No API is assumed to exist until confirmed, and no adapter exists for either.

**Impact if answered.** One adapter per channel; no change to the ledger, the payment domain or
reconciliation.

---

## 3. Instalment policy — _needed by Phase 4_

**Question.** May a parent pay any amount toward a balance, must payments follow fixed
increments, or is there a formal instalment schedule with dates? If a scheduled instalment is
missed, is the consequence a reminder only, or a late-fee surcharge?

**Working assumption.** Configurable per school, defaulting to: any amount at or above a
configurable minimum; optional formal schedules attachable to a fee structure; a missed
instalment triggers a reminder only. Late fees, if ever enabled, go through the authorised
adjustment workflow with a reason, an approver and an audit entry — never added silently.

**Impact if different.** Payment validation rules and the parent portal's payment form; the
schedule entities already exist either way.

---

## 4. Mid-term transfer and withdrawal charges — _needed by Phase 9_

**Question.** When a student transfers or withdraws part-way through a term, does the full
term charge stand, is it prorated, or is a partial refund issued?

**Working assumption.** School-configurable: `FULL_TERM_CHARGE` (default),
`PRORATE_BY_DAYS`, or `REFUND_VIA_WORKFLOW`. Proration uses `Money.prorate`, which is already
implemented and tested.

**Impact if different.** Only the default value of a configuration field.

---

## 5. Retention periods — _needed by Phase 11, informs Phase 1_

**Question.** How long must each record type be retained? Rwanda's financial record-keeping
rules and Law N° 058/2021 may impose different periods for tax-relevant financial records
versus general contact data.

**Working assumption.** Retention is a configurable policy per record type. The seeded
placeholder is **10 years for tax-relevant financial records**; this is a placeholder, not
advice, and must be confirmed. Financial totals and audit entries are never deleted —
retention and deletion apply to _identifying personal data_, because deleting the audit trail
would destroy auditability.

**Impact if different.** Configuration values and the data-retention job schedule. The
distinction between "personal data" and "financial/audit record" is already in the design.

**Who can answer.** The school's accountant or auditor, plus RRA guidance.

---

## 6. Term count per academic year — _resolved in design, confirm the default_

**Question.** How many terms per academic year?

**Working assumption.** Rwandan schools commonly use three, but the count is **not** hard-coded
anywhere — `Term` is a first-class entity belonging to an academic year, and a school
administrator configures however many are needed.

**Impact if different.** None. Only seed data would change.

---

## 7. Parent portal languages — _needed by Phase 7_

**Question.** Do parent-facing screens need Kinyarwanda and/or French in addition to English?

**Working assumption.** English only for now. No translation framework is installed yet, but
user-facing strings are written as plain text in components rather than assembled from
fragments, so extraction later is mechanical rather than a rewrite.

**Impact if different.** Adding an i18n library and extracting strings — meaningful work, but
it does not change the architecture. Worth confirming before Phase 7 so it can be done once.

---

## 8. Separation of duties on manual verification — _implemented on the working assumption_

**Question.** Should the system _enforce_ that the bursar who verifies a manual payment claim
is not the one who submitted it, or only record both identities and flag self-verification in
reports?

**Working assumption, now built.** Enforced by default and relaxable per school through
`school_settings.enforce_verification_separation_of_duties`. A blocked attempt is audited as
`payment.manual_claim.self_verification_blocked` before it is refused, so repeated attempts are
visible rather than invisible — and where a school does relax the rule, the same audit trail
records who verified what. The check applies to verification by hand and to crediting from
reconciliation, which is the same act reached a different way.

**Still to confirm.** Whether a school that relaxes the flag wants self-verified payments
flagged in the Phase 8 reconciliation report as well as in the audit log.

**Impact if different.** One report column.

---

## 9. MFA scope — _needed by Phase 2_

**Question.** Should MFA be required for parents and students too, or only for
Bursar, Finance Manager, School Administrator and Super Administrator?

**Working assumption.** Required for the four high-privilege roles, as specified.
Parent/student accounts are password-only with standard password reset. The implementation is
role-driven, so extending it later is a configuration change.

**Impact if different.** Configuration, plus parent-facing enrolment guidance.

---

## 10. How a student account reaches its own records — _needed by Phase 5, blocking a role_

**Question.** How should a `STUDENT` login be connected to the `Student` record it belongs to?
By a link on the student row, by an explicit account-claim step, or should self-service be
guardian-only and the student role dropped?

**Why it is open.** The `STUDENT` role holds `own.financials_read` and `own.receipt_read`, but
nothing in the schema connects a `User` to the `Student` they are. There is no defensible rule
to invent for it: matching on email address would be wrong the first time a family shares one,
and guessing a linkage inside the module that guards financial data is exactly the kind of
invented business rule this project rules out.

**Working assumption.** Self-service access resolves through the **guardian link only**. A
student account therefore reaches no financial records at all — it fails closed, which is the
safe direction, and `payment.access.ts` says so in as many words rather than leaving a silent
gap.

**Impact if different.** A nullable `student.user_id` (or an explicit claim workflow), one more
branch in `resolveStudentFinancialAccess`, and the parent-portal screens re-pointed at it. No
change to payments, the ledger or reconciliation.

**Who can answer.** The school: whether students are issued their own logins at all, which for
a day/boarding secondary school is as much a policy question as a technical one.

---

## 11. What a school wants done with an unattributable deposit — _needed by Phase 7_

**Question.** When money arrives that no payment claim accounts for — a parent who paid without
quoting a reference and never told the school — what should happen to it? Hold it unattributed
indefinitely, credit it against the family once identified by other means, or return it?

**Why it is open.** Phase 5 makes the situation visible and refuses to guess: the line sits
`UNMATCHED` and appears in the reconciliation summary as money the school holds and cannot
explain. What it does not do is decide the school's policy for resolving it.

**Working assumption.** It stays unattributed and visible until a person attributes it to a
payment or sets it aside with a reason. Nothing expires it, and nothing writes it off.

**Impact if different.** A suspense-account concept, or an ageing rule with a report behind it.
Both are additions to reconciliation rather than changes to it.

**Who can answer.** The bursar's office, and probably the school's auditor.
