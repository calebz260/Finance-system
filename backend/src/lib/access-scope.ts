/**
 * Tenant scoping (Section 5).
 *
 * Every read and write of tenant data goes through an `AccessScope`. There are exactly
 * two kinds:
 *
 *  - **school scope** — the normal case. Queries are filtered by `schoolId`, and any
 *    record fetched by id is checked against it before being returned.
 *  - **system scope** — the Super Administrator, who is not bound to one school.
 *
 * The point of making this a type rather than a convention is that a repository method
 * cannot be written without deciding which scope applies. There is no default, so
 * "forgot to filter by school" is a compile error rather than a data leak.
 *
 * System scope is deliberately awkward to construct: `AccessScope.system()` reads as an
 * unusual thing to do, and it appears in a diff.
 */
import { ErrorCode } from '@sfs/shared';

import { ForbiddenError, NotFoundError } from './errors.js';

export type AccessScopeKind = 'school' | 'system';

export class AccessScope {
  private constructor(
    readonly kind: AccessScopeKind,
    /** Present only for a school scope. */
    private readonly boundSchoolId: string | null,
  ) {
    Object.freeze(this);
  }

  /** The normal scope: everything is filtered to this school. */
  static forSchool(schoolId: string): AccessScope {
    if (schoolId.trim() === '') {
      throw new Error('AccessScope.forSchool requires a school id');
    }
    return new AccessScope('school', schoolId);
  }

  /**
   * Cross-school scope for a Super Administrator. Only the authentication layer should
   * build this, and only after confirming the user holds that role.
   */
  static system(): AccessScope {
    return new AccessScope('system', null);
  }

  get isSystem(): boolean {
    return this.kind === 'system';
  }

  /** The bound school id, or null under system scope. */
  get schoolId(): string | null {
    return this.boundSchoolId;
  }

  /**
   * The school id, asserting that this is a school scope. Used by writes, which must
   * always name the school a new record belongs to — a system administrator creating a
   * student still has to say which school it is for.
   */
  requireSchoolId(): string {
    if (this.boundSchoolId === null) {
      throw new ForbiddenError(
        'This action must be performed within a specific school.',
        ErrorCode.SCHOOL_SCOPE_VIOLATION,
        { logContext: { scope: this.kind } },
      );
    }
    return this.boundSchoolId;
  }

  /**
   * A Prisma `where` fragment for this scope. System scope contributes no filter, which
   * is the one place cross-school reads are possible — and it is explicit.
   */
  get filter(): { schoolId?: string } {
    return this.boundSchoolId === null ? {} : { schoolId: this.boundSchoolId };
  }

  /** Merge the scope filter into a `where` clause. */
  where<TWhere extends object>(clause: TWhere): TWhere & { schoolId?: string } {
    return { ...clause, ...this.filter };
  }

  /** True when a record belongs to this scope. */
  permits(record: { schoolId: string | null }): boolean {
    if (this.boundSchoolId === null) return true;
    return record.schoolId === this.boundSchoolId;
  }

  /**
   * Guard for the read-then-check pattern: a record fetched by primary key has not been
   * filtered by school, so it must be verified before being returned or modified.
   *
   * Responds 404, not 403, on purpose. Answering "forbidden" would confirm that the id
   * exists in some other school, which is itself a disclosure — an attacker enumerating
   * ids must not be able to tell "does not exist" from "belongs to someone else". The
   * distinction is recorded in the logs, where it is useful, rather than in the response.
   */
  assertPermits(record: { schoolId: string | null } | null, description = 'record'): void {
    if (record !== null && this.permits(record)) return;

    throw new NotFoundError(`The requested ${description} was not found.`, {
      logContext: {
        // Tagged so a genuine cross-school attempt is distinguishable in the logs from an
        // ordinary missing record.
        violation: record === null ? 'missing_record' : ErrorCode.SCHOOL_SCOPE_VIOLATION,
        scope: this.kind,
        scopeSchoolId: this.boundSchoolId,
        recordSchoolId: record?.schoolId ?? null,
      },
    });
  }
}
