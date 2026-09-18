# Open questions

Decisions that need confirmation from the school, the DOS, or a payment provider. Each has a
**working assumption** so development is not blocked, and each records what changes if the
answer differs. They are listed in the order they start to matter.

---

## 1. Bank of Kigali integration type — _needed by Phase 5_

**Question.** For the school's BK collection account, does BK offer a real-time payment
notification API or webhook, or only a fixed collection account number reconciled from
statements?

**Working assumption.** BK is the most likely of the three channels to expose a real API, so
the sandbox/mock provider adapter is built against it. If it turns out to be
statement-reconciled, BK routes through the manual verification workflow instead.

**Impact if different.** None architecturally — the provider port and the manual workflow are
both built regardless. It only changes which adapter is real and which is a stub.

**Who can answer.** BK corporate/business banking, for this specific account.

---

## 2. Zigama CSS and Umwarimu SACCO integration type — _needed by Phase 5_

**Question.** Do either expose a payment-notification API for school fees, or does the school
receive a remittance/statement to reconcile?

**Working assumption.** Statement-reconciled (manual verification path). No API is assumed to
exist until confirmed.

**Impact if different.** An additional adapter per channel; no change to the ledger or
reconciliation logic.

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

## 8. Separation of duties on manual verification — _needed by Phase 5_

**Question.** Should the system _enforce_ that the bursar who verifies a manual payment claim
is not the one who submitted it, or only record both identities and flag self-verification in
reports?

**Working assumption.** Enforce it by default, with a school-level configuration flag to relax
it — a small school may have only one bursar, in which case a hard block would make the system
unusable. Self-verification, where permitted, is flagged in the reconciliation report.

**Impact if different.** One authorisation check and one configuration field.

---

## 9. MFA scope — _needed by Phase 2_

**Question.** Should MFA be required for parents and students too, or only for
Bursar, Finance Manager, School Administrator and Super Administrator?

**Working assumption.** Required for the four high-privilege roles, as specified.
Parent/student accounts are password-only with standard password reset. The implementation is
role-driven, so extending it later is a configuration change.

**Impact if different.** Configuration, plus parent-facing enrolment guidance.
