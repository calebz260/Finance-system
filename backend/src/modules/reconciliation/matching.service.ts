/**
 * Deciding which payment a statement line belongs to.
 *
 * Pure and unit-tested, because this is the module that proposes crediting a family's
 * account with money that arrived at the bank, and the cost of the two failure modes is
 * not symmetric:
 *
 *  - A **missed** match costs a bursar a minute of reading.
 *  - A **wrong** match credits the wrong family, leaves the right one still owing, and is
 *    discovered weeks later by a parent with a receipt.
 *
 * So the automatic pass is deliberately narrow. It attributes a line only when the
 * payment's own reference is quoted on it **and** the amounts are exactly equal. That is
 * the one situation where there is nothing to interpret: the payer quoted the reference the
 * school issued, and the bank confirms the figure the school was expecting.
 *
 * Everything else becomes a *suggestion*, ranked, for a person to accept or reject —
 * including several plausible candidates, which is reported as ambiguity rather than
 * resolved by picking the first (Section 20).
 *
 * Suggestions are computed per request and never stored: a stored suggestion goes stale
 * the moment the payment it names is verified or cancelled.
 */
import {
  isValidPaymentReference,
  Money,
  PAYMENT_REFERENCE_PREFIX,
  type CurrencyCode,
} from '@sfs/shared';

import type { CandidatePaymentRecord } from './reconciliation.repository.js';

/** What the matcher is shown about a line. */
export interface MatchableLine {
  readonly id: string;
  readonly narrative: string;
  readonly reference: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly valueDate: Date;
}

export interface ScoredCandidate {
  readonly payment: CandidatePaymentRecord;
  /** Higher is better. Only used to order suggestions, never to decide one. */
  readonly score: number;
  readonly reason: string;
  readonly amountMatches: boolean;
  /** True when the line quotes this payment's own reference. */
  readonly referenceQuoted: boolean;
}

export type LineVerdict =
  /** Exactly one candidate, with its reference quoted and its amount equal. */
  | { readonly kind: 'AUTOMATIC'; readonly paymentId: string; readonly reason: string }
  /** More than one candidate is equally plausible. A person decides. */
  | { readonly kind: 'AMBIGUOUS'; readonly candidates: readonly ScoredCandidate[] }
  /** Nothing conclusive. Any candidates found are offered as suggestions. */
  | { readonly kind: 'UNMATCHED'; readonly candidates: readonly ScoredCandidate[] };

/**
 * Every payment reference quoted anywhere on a line.
 *
 * Searched in the narrative *and* the reference column, because banks put the payer's
 * note in whichever of the two they feel like. Matched on the issued format
 * (`PAY-YYYY-NNNNNNNNN`) so a random digit string cannot be read as a reference.
 */
export function referencesQuotedOn(line: MatchableLine): readonly string[] {
  const haystack = `${line.narrative} ${line.reference ?? ''}`.toUpperCase();
  const pattern = new RegExp(`${PAYMENT_REFERENCE_PREFIX}[-\\s]?(\\d{4})[-\\s]?(\\d{9})`, 'g');

  const found = new Set<string>();
  for (const match of haystack.matchAll(pattern)) {
    // Rebuilt in the canonical form, so a reference written `PAY 2026 000000123` matches
    // the one stored as `PAY-2026-000000123`.
    const candidate = `${PAYMENT_REFERENCE_PREFIX}-${match[1] ?? ''}-${match[2] ?? ''}`;
    if (isValidPaymentReference(candidate)) found.add(candidate);
  }

  return [...found];
}

/** Words worth comparing: the payer's name, stripped of noise a bank adds. */
function nameTokens(value: string): readonly string[] {
  return value
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

/** True when the payer's name appears on the line. */
function payerNameAppears(line: MatchableLine, payment: CandidatePaymentRecord): boolean {
  const haystack = `${line.narrative} ${line.reference ?? ''}`.toUpperCase();
  const tokens = nameTokens(payment.payerName);
  if (tokens.length === 0) return false;
  // Every token, not any: "JEAN" alone matches half a school's parents.
  return tokens.every((token) => haystack.includes(token));
}

/** True when the reference the payer quoted to the school appears on the line. */
function externalReferenceAppears(line: MatchableLine, payment: CandidatePaymentRecord): boolean {
  const quoted = payment.externalReference?.trim().toUpperCase() ?? '';
  // Short strings match by accident. Four characters is the shortest a bank reference
  // usefully gets, and below that the coincidence rate is not worth the suggestion.
  if (quoted.length < 4) return false;
  return `${line.narrative} ${line.reference ?? ''}`.toUpperCase().includes(quoted);
}

function amountsEqual(line: MatchableLine, payment: CandidatePaymentRecord): boolean {
  const currency = line.currency as CurrencyCode;
  if (payment.currency !== line.currency) return false;
  return Money.fromDatabase(payment.amount, currency).equals(Money.of(line.amount, currency));
}

/**
 * Score one candidate against a line.
 *
 * The score orders the list a bursar reads; it never decides a match on its own. The
 * reason is the part that matters, because it is what the bursar checks before accepting.
 */
export function scoreCandidate(
  line: MatchableLine,
  payment: CandidatePaymentRecord,
  quotedReferences: readonly string[],
): ScoredCandidate | null {
  const referenceQuoted = quotedReferences.includes(payment.reference);
  const amountMatches = amountsEqual(line, payment);
  const externalMatch = externalReferenceAppears(line, payment);
  const nameMatch = payerNameAppears(line, payment);

  let score = 0;
  const reasons: string[] = [];

  if (referenceQuoted) {
    score += 100;
    reasons.push('the payment reference is quoted on the statement line');
  }
  if (externalMatch) {
    score += 40;
    reasons.push('the bank reference the payer gave appears on the line');
  }
  if (amountMatches) {
    score += 30;
    reasons.push('the amount is exactly the same');
  }
  if (nameMatch) {
    score += 20;
    reasons.push('the payer’s name appears on the line');
  }

  // Nothing but a name, or nothing at all, is not a suggestion — it is a guess, and a
  // list of guesses is how a bursar ends up clicking the first one.
  if (score < 30) return null;

  return {
    payment,
    score,
    reason: reasons.join('; '),
    amountMatches,
    referenceQuoted,
  };
}

/**
 * What should happen to one line.
 *
 * Money out is never attributed to a payment: a bank charge or an outward transfer is not
 * a student's fees, and the database refuses it too.
 */
export function classifyLine(
  line: MatchableLine,
  direction: 'MONEY_IN' | 'MONEY_OUT',
  candidates: readonly CandidatePaymentRecord[],
): LineVerdict {
  if (direction === 'MONEY_OUT') return { kind: 'UNMATCHED', candidates: [] };

  const quoted = referencesQuotedOn(line);

  const scored = candidates
    .map((payment) => scoreCandidate(line, payment, quoted))
    .filter((candidate): candidate is ScoredCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score);

  // The only automatic case: the reference the school issued is quoted, and the amount
  // agrees. One such candidate is a match; two would mean two payments share a reference,
  // which the unique index makes impossible — so it is treated as ambiguity rather than
  // trusted.
  const conclusive = scored.filter(
    (candidate) => candidate.referenceQuoted && candidate.amountMatches,
  );

  if (conclusive.length === 1) {
    const only = conclusive[0]!;
    return {
      kind: 'AUTOMATIC',
      paymentId: only.payment.id,
      reason: only.reason,
    };
  }
  if (conclusive.length > 1) return { kind: 'AMBIGUOUS', candidates: conclusive };

  // A reference quoted with a *different* amount is deliberately not a match. It is the
  // most useful suggestion there is, and the least safe thing to apply automatically:
  // either the payer paid a different amount or the line is not theirs, and both need a
  // person.
  const ambiguous = scored.filter((candidate) => candidate.amountMatches).length > 1;

  return ambiguous
    ? { kind: 'AMBIGUOUS', candidates: scored }
    : { kind: 'UNMATCHED', candidates: scored };
}
