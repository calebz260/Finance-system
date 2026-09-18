/**
 * Money value object for the School Finance System.
 *
 * Every monetary amount in this system -- charges, payments, adjustments, balances --
 * flows through this class. Rules it enforces, once, for the whole codebase:
 *
 *  - Amounts are arbitrary-precision decimals, never IEEE-754 floats.
 *  - Storage scale is fixed at 2 decimal places, matching `NUMERIC(14, 2)` in PostgreSQL.
 *  - Rounding is round-half-up, everywhere, with no per-call-site overrides.
 *  - Arithmetic across different currencies throws instead of silently coercing.
 *  - Splitting an amount (proration, instalments) uses `allocate`, which is
 *    remainder-preserving: the parts always add back up to the original.
 *
 * Frontend code may construct and display Money, but must never derive a balance with
 * it -- balances are always computed server-side and sent down as strings.
 */
// Named import: decimal.js declares `Decimal` as an exported class merged with a
// namespace of types. The default export does not carry the static ROUND_* constants
// through, so importing by name is what makes `Decimal.ROUND_HALF_UP` typed.
import { Decimal } from 'decimal.js';

/**
 * Local Decimal constructor. Cloned rather than configuring the global instance so this
 * module cannot change decimal behaviour for unrelated code in the same process.
 * `toExpNeg`/`toExpPos` are pushed out of range so `toFixed()` never emits exponential
 * notation into a receipt or a SQL parameter.
 */
const Dec = Decimal.clone({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export type DecimalLike = InstanceType<typeof Dec>;

/** The only rounding mode used for money in this system. */
export const MONEY_ROUNDING = Decimal.ROUND_HALF_UP;

/** Decimal places persisted for every monetary column. */
export const MONEY_STORAGE_SCALE = 2;

/** Total digits available in `NUMERIC(14, 2)`. */
export const MONEY_PRECISION = 14;

/** Largest amount representable in `NUMERIC(14, 2)`: 999,999,999,999.99 */
export const MONEY_MAX = '999999999999.99';

export type CurrencyCode = 'RWF' | 'USD' | 'EUR';

export interface CurrencyDefinition {
  readonly code: CurrencyCode;
  /** Decimal places shown to humans. RWF subunits are not used in practice. */
  readonly displayScale: number;
  readonly symbol: string;
  readonly name: string;
}

export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyDefinition>> = Object.freeze({
  RWF: { code: 'RWF', displayScale: 0, symbol: 'RWF', name: 'Rwandan Franc' },
  USD: { code: 'USD', displayScale: 2, symbol: '$', name: 'US Dollar' },
  EUR: { code: 'EUR', displayScale: 2, symbol: '€', name: 'Euro' },
});

/** School default. Any new currency must be added to CURRENCIES, not hard-coded. */
export const DEFAULT_CURRENCY: CurrencyCode = 'RWF';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export type MoneyInput = string | number | bigint | Money | DecimalLike;

function toDecimal(value: MoneyInput): DecimalLike {
  if (value instanceof Money) return value.amount;
  if (typeof value === 'bigint') return new Dec(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MoneyError(`Monetary value must be finite, received ${String(value)}`);
    }
    // A number literal is accepted for ergonomics in tests and seed data, but it is
    // stringified first so we never inherit binary floating-point artefacts.
    return new Dec(value.toString());
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') throw new MoneyError('Monetary value must not be an empty string');
    // Reject grouped input ("1,000") rather than guessing the separator convention.
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
      throw new MoneyError(`Monetary value is not a plain decimal number: "${value}"`);
    }
    return new Dec(trimmed);
  }
  // Duck-typed rather than `instanceof Dec`: a Decimal produced by decimal.js itself or
  // by Prisma's bundled copy is a different constructor but the same value semantics.
  if (typeof value === 'object' && value !== null && typeof value.toFixed === 'function') {
    return new Dec(value.toString());
  }
  throw new MoneyError(`Unsupported monetary value of type ${typeof value}`);
}

export class Money {
  private constructor(
    /** Always already rounded to MONEY_STORAGE_SCALE. */
    readonly amount: DecimalLike,
    readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  /**
   * Build a Money from user input, configuration or seed data. The value is rounded to
   * the storage scale immediately, so a Money instance and its persisted form are
   * always identical -- there is no "unrounded in memory, rounded on save" gap.
   */
  static of(value: MoneyInput, currency: CurrencyCode = DEFAULT_CURRENCY): Money {
    if (!(currency in CURRENCIES)) {
      throw new MoneyError(`Unknown currency code: ${String(currency)}`);
    }
    const raw = toDecimal(value);
    if (!raw.isFinite()) throw new MoneyError('Monetary value must be finite');

    const rounded = raw.toDecimalPlaces(MONEY_STORAGE_SCALE, MONEY_ROUNDING);
    if (rounded.abs().greaterThan(new Dec(MONEY_MAX))) {
      throw new MoneyError(
        `Monetary value ${rounded.toFixed(MONEY_STORAGE_SCALE)} exceeds the maximum ` +
          `storable amount (${MONEY_MAX})`,
      );
    }
    return new Money(rounded, currency);
  }

  /** Parse a value read back from PostgreSQL `NUMERIC` (Prisma Decimal or string). */
  static fromDatabase(
    value: string | number | { toString(): string },
    currency: CurrencyCode = DEFAULT_CURRENCY,
  ): Money {
    if (typeof value === 'string' || typeof value === 'number') return Money.of(value, currency);
    return Money.of(value.toString(), currency);
  }

  static zero(currency: CurrencyCode = DEFAULT_CURRENCY): Money {
    return Money.of('0', currency);
  }

  /** True when `value` can be parsed as money. Used by validators before coercion. */
  static isValid(value: unknown, currency: CurrencyCode = DEFAULT_CURRENCY): boolean {
    try {
      Money.of(value as MoneyInput, currency);
      return true;
    } catch {
      return false;
    }
  }

  static sum(values: readonly Money[], currency: CurrencyCode = DEFAULT_CURRENCY): Money {
    if (values.length === 0) return Money.zero(currency);
    return values.reduce((acc, item) => acc.plus(item), Money.zero(values[0]!.currency));
  }

  static min(a: Money, b: Money): Money {
    return a.lessThan(b) ? a : b;
  }

  static max(a: Money, b: Money): Money {
    return a.greaterThan(b) ? a : b;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new MoneyError(
        `Cannot combine ${this.currency} with ${other.currency}; convert explicitly first`,
      );
    }
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amount.plus(other.amount), this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amount.minus(other.amount), this.currency);
  }

  /** Multiply by a dimensionless factor (e.g. a 0.25 scholarship rate). */
  times(factor: string | number): Money {
    return Money.of(this.amount.times(toDecimal(factor)), this.currency);
  }

  /** Divide by a dimensionless divisor. Use `allocate` when splitting a total. */
  dividedBy(divisor: string | number): Money {
    const d = toDecimal(divisor);
    if (d.isZero()) throw new MoneyError('Cannot divide a monetary amount by zero');
    return Money.of(this.amount.dividedBy(d), this.currency);
  }

  /**
   * Proportional share: `this * numerator / denominator`, e.g. prorating a term charge
   * across the days a withdrawing student actually attended (Section 8).
   */
  prorate(numerator: string | number, denominator: string | number): Money {
    const den = toDecimal(denominator);
    if (den.isZero()) throw new MoneyError('Cannot prorate with a zero denominator');
    return Money.of(this.amount.times(toDecimal(numerator)).dividedBy(den), this.currency);
  }

  /**
   * Split this amount into parts weighted by `weights`, preserving the total exactly.
   * Rounding remainders are distributed one minor unit at a time from the first part
   * onward, so three-way splits of 100 give 33.34 / 33.33 / 33.33 rather than losing a
   * cent. Used for instalment schedules and multi-fee payment application.
   */
  allocate(weights: ReadonlyArray<string | number>): Money[] {
    if (weights.length === 0) throw new MoneyError('Cannot allocate across zero parts');

    const decWeights = weights.map((w) => toDecimal(w));
    if (decWeights.some((w) => w.isNegative())) {
      throw new MoneyError('Allocation weights must not be negative');
    }
    const totalWeight = decWeights.reduce((acc, w) => acc.plus(w), new Dec(0));
    if (totalWeight.isZero()) throw new MoneyError('Allocation weights must not sum to zero');

    const unit = new Dec(10).pow(-MONEY_STORAGE_SCALE);
    const parts: DecimalLike[] = decWeights.map((w) =>
      this.amount
        .times(w)
        .dividedBy(totalWeight)
        .toDecimalPlaces(MONEY_STORAGE_SCALE, Decimal.ROUND_DOWN),
    );

    let remainder = this.amount.minus(parts.reduce((acc, p) => acc.plus(p), new Dec(0)));
    const step = remainder.isNegative() ? unit.negated() : unit;
    let index = 0;
    // Bounded by construction: |remainder| < parts.length * unit.
    while (!remainder.isZero() && index < parts.length * 2) {
      const target = index % parts.length;
      parts[target] = parts[target]!.plus(step);
      remainder = remainder.minus(step);
      index += 1;
    }

    return parts.map((p) => Money.of(p, this.currency));
  }

  negated(): Money {
    return Money.of(this.amount.negated(), this.currency);
  }

  abs(): Money {
    return Money.of(this.amount.abs(), this.currency);
  }

  /** Negative amounts clamped to zero -- e.g. an overpaid account owes nothing. */
  clampToZero(): Money {
    return this.isNegative() ? Money.zero(this.currency) : this;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.amount.comparedTo(other.amount) as -1 | 0 | 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.isPositive() && !this.amount.isZero();
  }

  /** Canonical persisted/transport form: a fixed-scale plain decimal string. */
  toString(): string {
    return this.amount.toFixed(MONEY_STORAGE_SCALE);
  }

  /** Money crosses the API boundary as a string, never as a JSON number. */
  toJSON(): string {
    return this.toString();
  }

  toNumber(): number {
    return this.amount.toNumber();
  }

  get definition(): CurrencyDefinition {
    return CURRENCIES[this.currency];
  }

  /** Human-readable, grouped, rounded to the currency's display scale. */
  format(options: { withCurrency?: boolean; locale?: string } = {}): string {
    const { withCurrency = true, locale = 'en-RW' } = options;
    const def = this.definition;
    const display = this.amount.toDecimalPlaces(def.displayScale, MONEY_ROUNDING);
    const grouped = new Intl.NumberFormat(locale, {
      minimumFractionDigits: def.displayScale,
      maximumFractionDigits: def.displayScale,
      useGrouping: true,
    }).format(display.toNumber());
    return withCurrency ? `${def.symbol} ${grouped}` : grouped;
  }
}

/** Convenience factory for the school's default currency. */
export const rwf = (value: MoneyInput): Money => Money.of(value, 'RWF');
