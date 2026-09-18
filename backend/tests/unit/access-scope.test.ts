import { describe, expect, it } from 'vitest';

import { AccessScope } from '../../src/lib/access-scope.js';
import { NotFoundError } from '../../src/lib/errors.js';

const SCHOOL_A = '11111111-1111-1111-1111-111111111111';
const SCHOOL_B = '22222222-2222-2222-2222-222222222222';

describe('AccessScope.forSchool', () => {
  it('produces a filter that scopes every query to the school', () => {
    const scope = AccessScope.forSchool(SCHOOL_A);

    expect(scope.kind).toBe('school');
    expect(scope.isSystem).toBe(false);
    expect(scope.schoolId).toBe(SCHOOL_A);
    expect(scope.filter).toEqual({ schoolId: SCHOOL_A });
  });

  it('merges the school filter into a where clause without dropping the caller clause', () => {
    const scope = AccessScope.forSchool(SCHOOL_A);
    expect(scope.where({ status: 'ACTIVE', id: 'abc' })).toEqual({
      status: 'ACTIVE',
      id: 'abc',
      schoolId: SCHOOL_A,
    });
  });

  it('cannot be constructed without a school id', () => {
    expect(() => AccessScope.forSchool('')).toThrow(/requires a school id/);
    expect(() => AccessScope.forSchool('   ')).toThrow(/requires a school id/);
  });

  it('is immutable, so a scope cannot be widened after construction', () => {
    const scope = AccessScope.forSchool(SCHOOL_A);
    expect(Object.isFrozen(scope)).toBe(true);
  });
});

describe('AccessScope.system', () => {
  it('contributes no filter, which is the only way a cross-school read happens', () => {
    const scope = AccessScope.system();

    expect(scope.isSystem).toBe(true);
    expect(scope.schoolId).toBeNull();
    expect(scope.filter).toEqual({});
    expect(scope.where({ status: 'ACTIVE' })).toEqual({ status: 'ACTIVE' });
  });

  it('refuses a write that must name a school', () => {
    // A system administrator creating a student still has to say which school it is for.
    expect(() => AccessScope.system().requireSchoolId()).toThrow(
      /must be performed within a specific school/,
    );
  });
});

describe('AccessScope.permits', () => {
  it('accepts a record from the same school and rejects another school', () => {
    const scope = AccessScope.forSchool(SCHOOL_A);
    expect(scope.permits({ schoolId: SCHOOL_A })).toBe(true);
    expect(scope.permits({ schoolId: SCHOOL_B })).toBe(false);
    expect(scope.permits({ schoolId: null })).toBe(false);
  });

  it('accepts anything under system scope', () => {
    const scope = AccessScope.system();
    expect(scope.permits({ schoolId: SCHOOL_B })).toBe(true);
    expect(scope.permits({ schoolId: null })).toBe(true);
  });
});

describe('AccessScope.assertPermits', () => {
  it('passes a record belonging to the scope', () => {
    const scope = AccessScope.forSchool(SCHOOL_A);
    expect(() => {
      scope.assertPermits({ schoolId: SCHOOL_A }, 'student');
    }).not.toThrow();
  });

  it('reports not-found for a record from another school, not forbidden', () => {
    // Answering 403 would confirm the id exists somewhere, which is itself a disclosure:
    // an attacker enumerating ids must not be able to tell "does not exist" from
    // "belongs to another school".
    const scope = AccessScope.forSchool(SCHOOL_A);
    let caught: unknown;
    try {
      scope.assertPermits({ schoolId: SCHOOL_B }, 'student');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NotFoundError);
    const error = caught as NotFoundError;
    expect(error.httpStatus).toBe(404);
    expect(error.message).toBe('The requested student was not found.');
  });

  it('responds identically for a missing record and a cross-school record', () => {
    const scope = AccessScope.forSchool(SCHOOL_A);
    const missing = (() => {
      try {
        scope.assertPermits(null, 'payment');
      } catch (error) {
        return error as NotFoundError;
      }
      throw new Error('expected a throw');
    })();
    const crossSchool = (() => {
      try {
        scope.assertPermits({ schoolId: SCHOOL_B }, 'payment');
      } catch (error) {
        return error as NotFoundError;
      }
      throw new Error('expected a throw');
    })();

    expect(missing.httpStatus).toBe(crossSchool.httpStatus);
    expect(missing.message).toBe(crossSchool.message);
    expect(missing.code).toBe(crossSchool.code);
  });

  it('records the difference in the log context, where it is useful', () => {
    const scope = AccessScope.forSchool(SCHOOL_A);
    try {
      scope.assertPermits({ schoolId: SCHOOL_B }, 'payment');
      expect.unreachable('expected a throw');
    } catch (error) {
      expect((error as NotFoundError).logContext).toMatchObject({
        violation: 'SCHOOL_SCOPE_VIOLATION',
        scopeSchoolId: SCHOOL_A,
        recordSchoolId: SCHOOL_B,
      });
    }

    try {
      scope.assertPermits(null, 'payment');
      expect.unreachable('expected a throw');
    } catch (error) {
      expect((error as NotFoundError).logContext).toMatchObject({
        violation: 'missing_record',
      });
    }
  });
});
