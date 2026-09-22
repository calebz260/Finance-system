/**
 * The API contract shared by the backend and the web client.
 *
 * Both sides import these types, so a response shape cannot drift between the server
 * that produces it and the screen that renders it without a compile error.
 */
import type { PermissionKey, RoleKey } from './authorization.js';

/** Machine-readable error codes. The frontend branches on these, never on message text. */
export const ErrorCode = {
  // Validation & request shape
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  // Authentication & authorisation
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  MFA_ENROLMENT_REQUIRED: 'MFA_ENROLMENT_REQUIRED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSION: 'INSUFFICIENT_PERMISSION',
  SCHOOL_SCOPE_VIOLATION: 'SCHOOL_SCOPE_VIOLATION',

  // Resources & state
  NOT_FOUND: 'NOT_FOUND',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  /** Optimistic-locking failure: reload the record and retry (Section 13). */
  RECORD_MODIFIED: 'RECORD_MODIFIED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',

  // Financial domain
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  AMOUNT_EXCEEDS_BALANCE: 'AMOUNT_EXCEEDS_BALANCE',
  AMOUNT_BELOW_MINIMUM: 'AMOUNT_BELOW_MINIMUM',
  DUPLICATE_PAYMENT: 'DUPLICATE_PAYMENT',
  PAYMENT_NOT_VERIFIED: 'PAYMENT_NOT_VERIFIED',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  AUTHORISATION_REQUIRED: 'AUTHORISATION_REQUIRED',
  PERIOD_CLOSED: 'PERIOD_CLOSED',

  // Infrastructure
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** One field-level validation problem, addressed by a dotted path into the request. */
export interface FieldError {
  /** e.g. `body.amount`, `query.page`, `params.studentId` */
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

export interface ApiErrorBody {
  readonly code: ErrorCode;
  /** Safe for display. Never contains SQL, stack traces or secrets. */
  readonly message: string;
  readonly fieldErrors?: readonly FieldError[];
  /** Extra machine-readable context, e.g. `{ minimumAmount: "1000.00" }`. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Correlates the response with server logs and audit entries. */
  readonly requestId: string;
  /** ISO-8601 UTC. */
  readonly timestamp: string;
}

export interface ApiErrorResponse {
  readonly error: ApiErrorBody;
}

export interface ApiSuccessResponse<TData> {
  readonly data: TData;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorResponse).error === 'object'
  );
}

/* ------------------------------------------------------------------ pagination */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

export interface PaginationMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

export interface PaginatedResponse<TItem> {
  readonly data: readonly TItem[];
  readonly meta: PaginationMeta;
}

export function buildPaginationMeta(args: {
  page: number;
  pageSize: number;
  totalItems: number;
}): PaginationMeta {
  const { page, pageSize, totalItems } = args;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalItems / pageSize)) : 1;
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

export type SortDirection = 'asc' | 'desc';

/* --------------------------------------------------------------- authentication */

/**
 * The caller's identity and the grants in force for this request.
 *
 * `permissions` is sent so the web client can decide what to render. It is never an
 * authorisation input: the backend re-reads permissions from the database on every
 * request and decides there (Section 26).
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** Null only for a Super Administrator, whose access is not scoped to one school. */
  readonly schoolId: string | null;
  readonly isSystemAdministrator: boolean;
  readonly mustChangePassword: boolean;
  readonly mfaEnabled: boolean;
  /** Whether the current session completed an MFA challenge. */
  readonly mfaSatisfied: boolean;
  readonly roleKeys: readonly RoleKey[];
  readonly permissions: readonly PermissionKey[];
}

/**
 * An established session.
 *
 * Carries the access token only. The refresh token is set as an httpOnly cookie scoped
 * to the auth routes, so it is never readable by JavaScript and is not attached to
 * ordinary API calls.
 */
export interface SessionPayload {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly user: AuthenticatedUser;
}

/**
 * What `POST /auth/login` returns. A correct password is not necessarily a session:
 * for a role that requires MFA it is the first of two steps, which is why this is a
 * discriminated union rather than an optional-field shape.
 */
export type LoginResult =
  | ({ readonly status: 'authenticated' } & SessionPayload)
  | {
      readonly status: 'mfa_required';
      /** Present this with a code at `POST /auth/mfa/verify`. Not an access token. */
      readonly challengeToken: string;
      readonly expiresInSeconds: number;
    }
  | {
      readonly status: 'mfa_enrolment_required';
      /** The role held requires MFA and the account has not enrolled yet. */
      readonly enrolmentToken: string;
      readonly expiresInSeconds: number;
    };

/** The details an authenticator app needs, returned once when enrolment starts. */
export interface MfaEnrolmentStartPayload {
  /** Base32, for manual entry when a QR code cannot be scanned. */
  readonly secret: string;
  /** `otpauth://` URI, usually rendered as a QR code. Contains the secret. */
  readonly otpauthUri: string;
}

/**
 * The result of confirming enrolment. Recovery codes are shown once and never
 * retrievable again -- only their hashes are stored.
 */
export interface MfaEnrolmentCompletedPayload {
  readonly recoveryCodes: readonly string[];
  /** Present when enrolment completed a sign-in, so a session now exists. */
  readonly session?: SessionPayload;
  /**
   * True when enrolling ended the caller's existing sessions, because a session that
   * never satisfied MFA cannot be upgraded in place.
   */
  readonly reauthenticationRequired: boolean;
}

export interface RecoveryCodesPayload {
  readonly recoveryCodes: readonly string[];
}

/* ------------------------------------------------------- user administration */

/**
 * Account lifecycle, mirroring the `user_status` enum in the database.
 *
 * Restated here rather than imported because `shared` must not depend on the generated
 * Prisma client. Drift is caught at compile time: the backend assigns the database enum
 * into this union when projecting a row, so adding a value on one side and not the other
 * fails the build.
 */
export type UserAccountStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'LOCKED' | 'DISABLED';

export interface UserRoleAssignment {
  readonly roleKey: RoleKey;
  readonly roleName: string;
  readonly rank: number;
  readonly requiresMfa: boolean;
  /** ISO-8601 UTC. */
  readonly assignedAt: string;
}

/**
 * A user account as an administration screen sees it.
 *
 * Contains no credential material: no password hash, no MFA secret, no tokens. What it
 * does carry is the security state an administrator needs in order to act — whether the
 * account is locked, whether MFA is enrolled, when it was last used.
 */
export interface UserAccount {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string | null;
  /** Null only for a Super Administrator. */
  readonly schoolId: string | null;
  readonly status: UserAccountStatus;
  readonly isSystemAdministrator: boolean;
  readonly mustChangePassword: boolean;
  readonly mfaEnabled: boolean;
  /** ISO-8601 UTC, or null when MFA has never been enrolled. */
  readonly mfaEnrolledAt: string | null;
  /** True while a brute-force lockout is in force. Derived from `lockedUntil`. */
  readonly locked: boolean;
  /** ISO-8601 UTC. */
  readonly lockedUntil: string | null;
  readonly failedLoginAttempts: number;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Pass back on an update; a stale value is rejected with `RECORD_MODIFIED`. */
  readonly version: number;
  readonly roles: readonly UserRoleAssignment[];
}

/**
 * The result of creating an account.
 *
 * `temporaryPassword` is present only when the server generated one, and only in this
 * one response — it is never stored in plaintext and never retrievable again. Until a
 * notification channel exists (Phase 6), handing it to the administrator who created the
 * account is how it reaches its owner.
 */
export interface CreatedUserAccount {
  readonly user: UserAccount;
  readonly temporaryPassword?: string;
}

/** A role and what it may do, for the administration screens. */
export interface RoleCatalogueEntry {
  readonly key: RoleKey;
  readonly name: string;
  readonly description: string | null;
  readonly rank: number;
  readonly requiresMfa: boolean;
  readonly permissions: readonly PermissionKey[];
}

/** One of the caller's live sessions, for a "where am I signed in?" screen. */
export interface SessionSummary {
  readonly id: string;
  /** True for the session making this request. */
  readonly current: boolean;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly mfaSatisfied: boolean;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
}

/* ------------------------------------------------------- academic structure */

export type PeriodState = 'UPCOMING' | 'ACTIVE' | 'CLOSED';
export type ProgramState = 'ACTIVE' | 'DISCONTINUED';

export interface DepartmentSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly programCount: number;
}

export interface ProgramSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly durationYears: number | null;
  readonly status: ProgramState;
  readonly sortOrder: number;
  readonly levelCount: number;
  readonly version: number;
}

/**
 * A stage within a programme.
 *
 * `nextLevelId` is what makes end-of-year promotion a data lookup rather than a rule in
 * code, and `isTerminal` marks the level after which a student has completed.
 */
export interface LevelSummary {
  readonly id: string;
  readonly programId: string;
  readonly programName: string;
  readonly code: string;
  readonly name: string;
  readonly sequence: number;
  readonly isTerminal: boolean;
  readonly nextLevelId: string | null;
}

export interface ClassSectionSummary {
  readonly id: string;
  readonly academicYearId: string;
  readonly levelId: string;
  readonly levelName: string;
  readonly code: string;
  readonly name: string;
  readonly capacity: number | null;
  readonly classTeacherName: string | null;
  /** Students currently enrolled in this section. Derived, never stored. */
  readonly enrolledCount: number;
  readonly version: number;
}

export interface TermSummary {
  readonly id: string;
  readonly academicYearId: string;
  readonly name: string;
  readonly sequence: number;
  /** ISO-8601 date, no time component. */
  readonly startDate: string;
  readonly endDate: string;
  readonly status: PeriodState;
  readonly isCurrent: boolean;
  readonly version: number;
}

export interface AcademicYearSummary {
  readonly id: string;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: PeriodState;
  readonly isCurrent: boolean;
  readonly terms: readonly TermSummary[];
  readonly version: number;
}

/* -------------------------------------------------------------------- students */

export type StudentState =
  'ACTIVE' | 'COMPLETED' | 'TRANSFERRED' | 'WITHDRAWN' | 'SUSPENDED' | 'ARCHIVED';

export type GenderValue = 'FEMALE' | 'MALE' | 'OTHER' | 'UNDISCLOSED';
export type ResidencyValue = 'DAY' | 'BOARDING';

export type EnrollmentState =
  'ENROLLED' | 'PROMOTED' | 'REPEATED' | 'COMPLETED' | 'TRANSFERRED_OUT' | 'WITHDRAWN';

export type EnrollmentKind = 'NEW' | 'CONTINUING' | 'REPEAT' | 'RE_ADMISSION' | 'TRANSFER_IN';

export type GuardianRelation = 'MOTHER' | 'FATHER' | 'GUARDIAN' | 'SIBLING' | 'SPONSOR' | 'OTHER';

/** A student as a list row: enough to identify and place them, and nothing more. */
export interface StudentSummary {
  readonly id: string;
  /** The human-facing identifier staff actually use, e.g. `STU-2026-00125`. */
  readonly studentId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly otherNames: string | null;
  readonly gender: GenderValue;
  readonly status: StudentState;
  readonly admissionDate: string;
  readonly admissionYear: number;
  /** The student's placement for the current academic year, when they have one. */
  readonly currentEnrollment: EnrollmentSummary | null;
  readonly version: number;
}

/** The full profile, for the student's own page. */
export interface StudentDetail extends StudentSummary {
  readonly dateOfBirth: string | null;
  readonly nationalIdNumber: string | null;
  readonly district: string | null;
  readonly sector: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly guardians: readonly StudentGuardianLink[];
  /** Newest first. Append-only: no historical enrolment is ever overwritten. */
  readonly enrollments: readonly EnrollmentSummary[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnrollmentSummary {
  readonly id: string;
  readonly studentId: string;
  readonly academicYearId: string;
  readonly academicYearName: string;
  readonly programId: string;
  readonly programName: string;
  readonly levelId: string;
  readonly levelName: string;
  readonly classSectionId: string | null;
  readonly classSectionName: string | null;
  readonly status: EnrollmentState;
  readonly enrollmentType: EnrollmentKind;
  readonly residency: ResidencyValue;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly exitReason: string | null;
  readonly version: number;
}

/* ------------------------------------------------------------------- guardians */

export interface GuardianSummary {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly altPhone: string | null;
  readonly email: string | null;
  readonly nationalIdNumber: string | null;
  readonly occupation: string | null;
  readonly district: string | null;
  readonly sector: string | null;
  readonly address: string | null;
  /** Set when the guardian has a parent-portal account. */
  readonly userId: string | null;
  readonly linkedStudentCount: number;
  readonly version: number;
}

/**
 * A guardian's link to one student, carrying the financial rights Section 26 turns into
 * authorisation checks. A parent may only see and pay for students they are linked to.
 */
export interface StudentGuardianLink {
  readonly id: string;
  readonly guardianId: string;
  readonly studentId: string;
  readonly guardianFirstName: string;
  readonly guardianLastName: string;
  readonly guardianPhone: string;
  readonly relationship: GuardianRelation;
  readonly isPrimaryContact: boolean;
  readonly isFinanciallyResponsible: boolean;
  readonly canViewFinancials: boolean;
  readonly canInitiatePayments: boolean;
  readonly version: number;
}

/* --------------------------------------------------------------- bulk import */

/**
 * One problem with one row of an uploaded file.
 *
 * `row` is the spreadsheet row number the person is looking at, counting the header as
 * row 1 — not a zero-based array index. Telling someone "row 0 is wrong" when their
 * screen shows row 2 is how an import becomes unusable at a thousand records.
 */
export interface ImportRowIssue {
  readonly row: number;
  /** The column header the problem belongs to, when it belongs to one. */
  readonly column: string | null;
  readonly message: string;
  /** The offending value, echoed back so the row is findable in a large file. */
  readonly value: string | null;
}

/** A row that parsed and validated, shown in the preview before anything is written. */
export interface ImportPreviewRow {
  readonly row: number;
  readonly firstName: string;
  readonly lastName: string;
  readonly otherNames: string | null;
  readonly gender: GenderValue;
  readonly dateOfBirth: string | null;
  readonly admissionDate: string;
  readonly levelCode: string;
  readonly programCode: string;
  readonly classSectionCode: string | null;
  readonly residency: ResidencyValue;
  readonly guardianName: string | null;
  readonly guardianPhone: string | null;
  readonly guardianRelationship: GuardianRelation | null;
}

/**
 * The result of validating an uploaded file, before any record is created.
 *
 * Nothing is written by a preview. The counts and the issue list are what a registrar
 * uses to decide whether to fix the spreadsheet or to proceed.
 */
export interface ImportPreview {
  readonly fileName: string;
  readonly totalRows: number;
  readonly validRows: number;
  readonly rowsWithIssues: number;
  /** Capped, because a file with one wrong header produces one issue per row. */
  readonly issues: readonly ImportRowIssue[];
  readonly issuesTruncated: boolean;
  /** The first rows that would be created, so the mapping can be eyeballed. */
  readonly sample: readonly ImportPreviewRow[];
}

/** The result of committing an import. */
export interface ImportResult {
  readonly studentsCreated: number;
  readonly guardiansCreated: number;
  readonly guardiansLinked: number;
  readonly enrollmentsCreated: number;
  /** Rows rejected by validation. An import either applies every valid row or none. */
  readonly rowsRejected: number;
  readonly issues: readonly ImportRowIssue[];
  readonly issuesTruncated: boolean;
}

/* ------------------------------------------------------------ fees and charges */

export type FeeStructureState = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type ChargeState = 'RAISED' | 'VOID';
export type AdjustmentMethodValue = 'FIXED' | 'PERCENTAGE';
export type ApprovalState = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REVERSED';

export type EntryDirectionValue = 'DEBIT' | 'CREDIT';
export type EntrySourceValue =
  'CHARGE' | 'DISCOUNT' | 'SCHOLARSHIP' | 'WAIVER' | 'ADJUSTMENT' | 'PAYMENT';

/**
 * The four kinds of record that change what a family owes.
 *
 * Each is its own table with its own rules. This union is the *read* model: the student
 * financial screen shows them in one list, ordered by when they happened, because that
 * is how someone reads an account. Writes go to the type-specific endpoints.
 */
export type ReliefKind = 'DISCOUNT' | 'SCHOLARSHIP' | 'WAIVER' | 'ADJUSTMENT';

/**
 * Which way a relief record moves the balance once approved.
 *
 * Derived in exactly one place so no call site has to remember a sign convention. Only
 * an adjustment can go either way, and it says so explicitly.
 */
export function reliefDirection(
  kind: ReliefKind,
  adjustmentDirection?: EntryDirectionValue,
): EntryDirectionValue {
  return kind === 'ADJUSTMENT' ? (adjustmentDirection ?? 'CREDIT') : 'CREDIT';
}

export interface FeeCategorySummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly sortOrder: number;
  /** Charges already raised against this category. Blocks deactivation from meaning erasure. */
  readonly chargeCount: number;
  readonly version: number;
}

export interface FeeStructureItemSummary {
  readonly id: string;
  readonly feeCategoryId: string;
  readonly feeCategoryCode: string;
  readonly feeCategoryName: string;
  readonly label: string;
  /** Decimal string at scale 2. Never a JavaScript number. */
  readonly amount: string;
  readonly sortOrder: number;
}

export interface FeeStructureSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly academicYearId: string;
  readonly academicYearName: string;
  /** Null means the structure is charged once for the whole year. */
  readonly termId: string | null;
  readonly termName: string | null;
  readonly programId: string | null;
  readonly programName: string | null;
  readonly levelId: string | null;
  readonly levelName: string | null;
  readonly classSectionId: string | null;
  readonly classSectionName: string | null;
  /** Null applies to both day students and boarders. */
  readonly residency: ResidencyValue | null;
  readonly status: FeeStructureState;
  readonly items: readonly FeeStructureItemSummary[];
  /** Sum of the items. Computed server-side. */
  readonly totalAmount: string;
  /** Once this is above zero the structure is locked against edits. */
  readonly chargeCount: number;
  readonly version: number;
}

export interface StudentChargeSummary {
  readonly id: string;
  readonly studentId: string;
  /** The human-facing identifier, e.g. `STU-2026-00125`. */
  readonly studentNumber: string;
  readonly studentName: string;
  readonly academicYearId: string;
  readonly academicYearName: string;
  readonly termId: string | null;
  readonly termName: string | null;
  readonly feeCategoryId: string;
  readonly feeCategoryName: string;
  readonly feeStructureId: string | null;
  readonly feeStructureName: string | null;
  /** Snapshot taken when the charge was raised. */
  readonly description: string;
  readonly amount: string;
  /** Approved credits applied to this charge. */
  readonly adjustedAmount: string;
  /** `amount - adjustedAmount`, floored at zero. */
  readonly netAmount: string;
  readonly status: ChargeState;
  readonly notes: string | null;
  readonly raisedAt: string;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly version: number;
}

/** A named award programme. The programme, not the money a student receives. */
export interface ScholarshipSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly sponsor: string | null;
  readonly defaultMethod: AdjustmentMethodValue;
  readonly defaultPercentage: string | null;
  readonly defaultAmount: string | null;
  readonly isActive: boolean;
  /** Awards made under it. Stops deactivation being read as erasure. */
  readonly awardCount: number;
  readonly version: number;
}

/**
 * One relief or adjustment record, in the unified read shape.
 *
 * `kind` says which table it came from. The fields that only apply to some kinds are
 * nullable rather than split into a discriminated union, because the screen that shows
 * these renders one table with one set of columns.
 */
export interface ReliefSummary {
  readonly id: string;
  readonly kind: ReliefKind;
  readonly direction: EntryDirectionValue;
  readonly studentId: string;
  readonly studentNumber: string;
  readonly studentName: string;
  readonly studentChargeId: string | null;
  readonly chargeDescription: string | null;
  readonly academicYearId: string;
  readonly termId: string | null;
  readonly termName: string | null;
  /** FIXED for waivers and adjustments, which are never expressed as a rate. */
  readonly method: AdjustmentMethodValue;
  readonly percentage: string | null;
  readonly amount: string;
  /** The scholarship programme's name, for a SCHOLARSHIP. Null otherwise. */
  readonly scholarshipId: string | null;
  readonly scholarshipName: string | null;
  readonly reason: string;
  readonly status: ApprovalState;
  readonly requestedByName: string;
  readonly requestedAt: string;
  readonly decidedByName: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
  readonly version: number;
}

/**
 * One line of the authoritative ledger.
 *
 * This is what a balance is actually made of. Shown on the student financial screen so a
 * bursar can point at the line that explains a number, rather than inferring it from the
 * business records.
 */
export interface FinancialEntrySummary {
  readonly id: string;
  readonly entryType: EntryDirectionValue;
  readonly amount: string;
  readonly source: EntrySourceValue;
  readonly description: string;
  readonly academicYearId: string;
  readonly termId: string | null;
  readonly termName: string | null;
  readonly studentChargeId: string | null;
  /** Set when this entry undoes an earlier one. */
  readonly reversalOfEntryId: string | null;
  readonly postedByName: string;
  readonly postedAt: string;
}

/**
 * A student's financial position.
 *
 * **Every figure comes from the financial ledger**, not from summing charges and relief
 * records. The breakdown fields are the ledger grouped by source, so they always add up
 * to `outstanding` by construction — a source record that never posted an entry cannot
 * appear in a total, and one that posted twice cannot be counted once (ADR-022).
 *
 * Amounts are decimal strings. The web client displays them and never derives one.
 *
 * `outstanding` and `creditBalance` are mutually exclusive: a net position in the
 * family's favour is reported as a credit rather than as a negative debt, so a negative
 * number never has to be interpreted (ADR-021).
 */
export interface StudentBalance {
  readonly studentId: string;
  readonly studentNumber: string;
  readonly studentName: string;
  readonly currency: string;
  /** Ledger DEBITs from charges. */
  readonly totalCharged: string;
  /** Ledger CREDITs from discounts, scholarships, waivers and crediting adjustments. */
  readonly totalCredited: string;
  /** Ledger DEBITs from debiting adjustments, e.g. an authorised late fee. */
  readonly totalSurcharged: string;
  /** Ledger CREDITs from payments. Always "0.00" until Phase 5 posts them. */
  readonly totalPaid: string;
  /** `Σ DEBIT − Σ CREDIT`, floored at zero. */
  readonly outstanding: string;
  /** The overpaid amount when the net position is in the family's favour. */
  readonly creditBalance: string;
  /** Requests awaiting a Finance Manager. They have posted nothing, so they are in no total above. */
  readonly pendingApprovalCount: number;
}

/** A balance broken down by the period it belongs to. */
export interface StudentBalancePeriod {
  readonly academicYearId: string;
  readonly academicYearName: string;
  readonly termId: string | null;
  readonly termName: string | null;
  readonly totalCharged: string;
  readonly totalCredited: string;
  readonly totalSurcharged: string;
  readonly totalPaid: string;
  readonly outstanding: string;
  readonly creditBalance: string;
}

export interface StudentFinancialSummary {
  readonly balance: StudentBalance;
  readonly periods: readonly StudentBalancePeriod[];
  readonly charges: readonly StudentChargeSummary[];
  /** Discounts, scholarship awards, waivers and adjustments, in one list. */
  readonly reliefs: readonly ReliefSummary[];
  /** The ledger lines the balance is actually computed from. */
  readonly entries: readonly FinancialEntrySummary[];
}

/** One student's line in a charge-generation preview. */
export interface ChargeRunPreviewLine {
  readonly studentId: string;
  readonly studentNumber: string;
  readonly studentName: string;
  readonly feeStructureId: string;
  readonly feeStructureName: string;
  readonly feeCategoryName: string;
  readonly description: string;
  readonly amount: string;
  /** True when an identical charge already exists and would be skipped. */
  readonly alreadyCharged: boolean;
}

/**
 * A conflict that stops a run before it writes anything: two matching structures that
 * would charge the same student the same category twice (ADR-019).
 */
export interface ChargeRunConflict {
  readonly feeCategoryName: string;
  readonly feeStructureIds: readonly string[];
  readonly feeStructureNames: readonly string[];
  readonly affectedStudentCount: number;
}

export interface ChargeRunPreview {
  readonly academicYearId: string;
  readonly termId: string | null;
  readonly studentsMatched: number;
  readonly chargesToCreate: number;
  readonly chargesToSkip: number;
  readonly totalAmount: string;
  readonly conflicts: readonly ChargeRunConflict[];
  readonly sample: readonly ChargeRunPreviewLine[];
  readonly sampleTruncated: boolean;
}

export interface ChargeRunResult {
  readonly chargeRunId: string;
  readonly studentsMatched: number;
  readonly chargesCreated: number;
  readonly chargesSkipped: number;
  readonly totalAmount: string;
}

/* ---------------------------------------------------------------- payments */

/**
 * How the money physically moved.
 *
 * Deliberately separate from `PaymentVerificationMethodValue` below, which says how the
 * school came to *believe* it moved. The two are independent: a bank transfer might be
 * confirmed by a provider callback at one bank and by a bursar reading a statement at
 * another, and conflating them would mean the verification rules changed whenever a
 * bank's integration did.
 */
export type PaymentMethodValue =
  'MOBILE_MONEY' | 'BANK_TRANSFER' | 'BANK_DEPOSIT' | 'CASH' | 'CHEQUE';

/**
 * What has to happen before a payment may credit the ledger.
 *
 *  - `PROVIDER` — a payment provider confirms it, and the confirmation is verified
 *    server-side against the provider's own record before anything is credited.
 *  - `MANUAL` — an authorised bursar confirms it against a bank statement or the cash
 *    they are holding. A first-class path, not an exception path (ADR-003).
 */
export type PaymentVerificationMethodValue = 'PROVIDER' | 'MANUAL';

/**
 * A payment's lifecycle.
 *
 * `SUCCESSFUL` is the only status that has credited the ledger, and it is reached only
 * through server-side verification. The two undo states are distinct on purpose:
 * `REVERSED` means the money never really arrived (a bank reversal, a claim confirmed in
 * error); `REFUNDED` means it arrived and was sent back. Both post a compensating ledger
 * entry and neither deletes anything.
 */
export type PaymentStatusValue =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCESSFUL'
  | 'FAILED'
  | 'CANCELLED'
  | 'REQUIRES_REVIEW'
  | 'REVERSED'
  | 'REFUNDED';

/** The channels the school collects through. */
export type PaymentProviderKeyValue =
  'SANDBOX' | 'BANK_OF_KIGALI' | 'ZIGAMA_CSS' | 'UMWARIMU_SACCO';

/** One attempt against a provider. `UNKNOWN` is a real outcome, not a missing one. */
export type PaymentTransactionStatusValue =
  'INITIATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'UNKNOWN';

/** Who or what caused a status transition. */
export type PaymentStatusChangeSourceValue =
  'USER' | 'PROVIDER_WEBHOOK' | 'PROVIDER_QUERY' | 'SYSTEM';

export type PaymentEvidenceKindValue =
  'BANK_SLIP' | 'TRANSFER_CONFIRMATION' | 'REMITTANCE_ADVICE' | 'OTHER';

/**
 * The payment status machine, as data.
 *
 * Declared here, once, so the server enforces and the browser renders from the same
 * table — a screen offering a "Verify" button for a payment the API would refuse is a
 * bug report waiting to happen. The server still checks; this only decides what is
 * offered.
 *
 * The rules that matter:
 *
 *  - Nothing leaves a terminal state except `SUCCESSFUL`, which may be undone by a
 *    reversal or a refund. A repeated callback arriving after a payment already failed
 *    therefore cannot resurrect it.
 *  - `PROCESSING` cannot be cancelled. Once a provider has the request, the school does
 *    not get to decide the money did not move; it waits for the confirmation or the
 *    failure.
 *  - `REQUIRES_REVIEW` is reachable from both live states and leads to a decision by a
 *    person. It is where a mismatch goes instead of being silently resolved.
 */
export const PAYMENT_STATUS_TRANSITIONS: Readonly<
  Record<PaymentStatusValue, readonly PaymentStatusValue[]>
> = Object.freeze({
  PENDING: ['PROCESSING', 'SUCCESSFUL', 'FAILED', 'CANCELLED', 'REQUIRES_REVIEW'],
  PROCESSING: ['SUCCESSFUL', 'FAILED', 'REQUIRES_REVIEW'],
  REQUIRES_REVIEW: ['SUCCESSFUL', 'FAILED', 'CANCELLED'],
  SUCCESSFUL: ['REVERSED', 'REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REVERSED: [],
  REFUNDED: [],
});

/** True when `to` is a permitted next status for `from`. */
export function canTransitionPayment(from: PaymentStatusValue, to: PaymentStatusValue): boolean {
  return PAYMENT_STATUS_TRANSITIONS[from].includes(to);
}

/** True when a payment can never change status again. */
export function isTerminalPaymentStatus(status: PaymentStatusValue): boolean {
  return PAYMENT_STATUS_TRANSITIONS[status].length === 0;
}

/** True when this status has credited the ledger. Exactly one status has. */
export function paymentHasCredited(status: PaymentStatusValue): boolean {
  return status === 'SUCCESSFUL' || status === 'REVERSED' || status === 'REFUNDED';
}

/**
 * A payment channel as offered to the person paying.
 *
 * `isAvailable` and `unavailableReason` are part of the contract rather than something
 * the browser infers: a channel whose provider integration is not yet confirmed must say
 * so plainly instead of presenting a button that fails (Section 40).
 */
export interface PaymentMethodOption {
  readonly method: PaymentMethodValue;
  readonly label: string;
  readonly verificationMethod: PaymentVerificationMethodValue;
  readonly providerKey: PaymentProviderKeyValue | null;
  readonly isAvailable: boolean;
  /** Why this channel cannot be used right now. Null when it can. */
  readonly unavailableReason: string | null;
  /** Whether a claim through this channel must carry proof of payment. */
  readonly requiresEvidence: boolean;
  /** What the payer has to do, for a channel the school reconciles by hand. */
  readonly instructions: string | null;
}

/** One provider attempt, as shown to finance staff. */
export interface PaymentTransactionSummary {
  readonly id: string;
  readonly providerKey: PaymentProviderKeyValue;
  /** The reference the school sent to the provider. */
  readonly internalReference: string;
  /** The provider's own identifier, once it has given one. */
  readonly providerTransactionId: string | null;
  readonly requestedAmount: string;
  /** What the provider says was actually taken. Null until it confirms. */
  readonly confirmedAmount: string | null;
  readonly currency: string;
  readonly status: PaymentTransactionStatusValue;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly initiatedAt: string;
  readonly completedAt: string | null;
}

/** One preserved status transition. */
export interface PaymentStatusHistoryEntry {
  readonly id: string;
  readonly fromStatus: PaymentStatusValue | null;
  readonly toStatus: PaymentStatusValue;
  readonly source: PaymentStatusChangeSourceValue;
  readonly reason: string | null;
  readonly actorName: string | null;
  readonly occurredAt: string;
}

/**
 * Proof attached to a manual claim.
 *
 * Carries no URL: the file is fetched from `/payments/:id/evidence/:evidenceId/file`
 * with the caller's own credentials, so a link cannot be forwarded to someone who may
 * not see it.
 */
export interface PaymentEvidenceSummary {
  readonly id: string;
  readonly kind: PaymentEvidenceKindValue;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  /** Lets a reviewer tell a re-uploaded duplicate from a genuinely different document. */
  readonly checksum: string;
  readonly uploadedByName: string;
  readonly uploadedAt: string;
  /** False once a later upload superseded it. Superseded evidence is never deleted. */
  readonly isCurrent: boolean;
}

/**
 * A payment, in the shape every list and detail screen reads.
 *
 * Every monetary field is a decimal string. Nothing here is a balance: a payment's
 * effect on what a family owes is the ledger entry it posted, and that is reported by
 * `StudentBalance` (ADR-022).
 */
export interface PaymentSummary {
  readonly id: string;
  /** e.g. `PAY-2026-000001234`. What a parent quotes on the phone. */
  readonly reference: string;
  readonly studentId: string;
  readonly studentNumber: string;
  readonly studentName: string;
  readonly amount: string;
  readonly currency: string;
  readonly method: PaymentMethodValue;
  readonly verificationMethod: PaymentVerificationMethodValue;
  readonly providerKey: PaymentProviderKeyValue | null;
  readonly status: PaymentStatusValue;
  readonly academicYearId: string;
  readonly academicYearName: string;
  readonly termId: string | null;
  readonly termName: string | null;
  readonly payerName: string;
  /** Provider or bank reference as supplied by the payer or the provider. */
  readonly externalReference: string | null;
  readonly failureReason: string | null;
  readonly initiatedByName: string;
  readonly initiatedAt: string;
  readonly completedAt: string | null;
  readonly verifiedByName: string | null;
  readonly verifiedAt: string | null;
  readonly reversedByName: string | null;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
  /** The ledger CREDIT this payment posted, once it has one. */
  readonly ledgerEntryId: string | null;
  readonly evidenceCount: number;
  readonly version: number;
}

/** A payment with everything a reviewer needs in one response. */
export interface PaymentDetail {
  readonly payment: PaymentSummary;
  readonly transactions: readonly PaymentTransactionSummary[];
  readonly statusHistory: readonly PaymentStatusHistoryEntry[];
  readonly evidence: readonly PaymentEvidenceSummary[];
  /** The ledger lines this payment produced: its credit, and any compensating entry. */
  readonly entries: readonly FinancialEntrySummary[];
}

/**
 * What a payer gets back from initiation.
 *
 * `payment.status` is authoritative and server-derived. `providerInstruction` carries
 * whatever the payer now has to do — approve a prompt on their handset, or deposit at a
 * branch and submit the slip — and is null when there is nothing left to do.
 */
export interface PaymentInitiationResult {
  readonly payment: PaymentSummary;
  readonly transaction: PaymentTransactionSummary | null;
  readonly providerInstruction: string | null;
  /**
   * True when this response replayed an existing payment because the idempotency key had
   * already been used. Nothing new was created.
   */
  readonly replayed: boolean;
}

/**
 * A student a signed-in parent or guardian may pay for.
 *
 * The outstanding figure is the ledger-derived balance, computed server-side, so the
 * amount a parent is offered to pay is the amount the system believes is owed.
 */
export interface PayableStudent {
  readonly studentId: string;
  readonly studentNumber: string;
  readonly studentName: string;
  readonly relationship: GuardianRelation;
  readonly currency: string;
  readonly outstanding: string;
  readonly creditBalance: string;
  readonly canViewFinancials: boolean;
  readonly canInitiatePayments: boolean;
}

/**
 * What a bursar's decision on a payment did.
 *
 * `outcome` is deliberately richer than "ok": a confirmation can credit, can find the
 * payment already credited by a provider callback that arrived first, or can discover
 * that the statement and the claim disagree — and the third case must not be reported as
 * a success. The screen branches on this, never on the message text.
 */
export interface PaymentVerificationResult {
  readonly payment: PaymentSummary;
  readonly outcome: 'CREDITED' | 'ALREADY_CREDITED' | 'HELD_FOR_REVIEW' | 'FAILED';
  /** The ledger CREDIT, when one exists. Null when nothing was credited. */
  readonly ledgerEntryId: string | null;
  /** One sentence, safe to show the verifier. */
  readonly message: string;
}

/** What a reversal or refund did. */
export interface PaymentReversalResult {
  readonly payment: PaymentSummary;
  readonly status: PaymentStatusValue;
  /**
   * Whether the opposing ledger entry was posted. False would mean a successful payment
   * had no live credit to undo, which is a fault worth surfacing rather than hiding.
   */
  readonly compensatingEntryPosted: boolean;
  readonly message: string;
}

/* ---------------------------------------------------------- reconciliation */

/**
 * Which way money moved on a bank statement line.
 *
 * Kept separate from the ledger's `EntryDirection` on purpose: a DEBIT on a student's
 * account and a debit on the school's bank account are opposite things, and one enum for
 * both would make reconciliation code impossible to read.
 */
export type BankStatementDirectionValue = 'MONEY_IN' | 'MONEY_OUT';

/** What has been decided about one statement line. */
export type StatementLineMatchStatusValue = 'UNMATCHED' | 'MATCHED' | 'IGNORED' | 'AMBIGUOUS';

/** One line of an imported statement, as the reconciliation screen reads it. */
export interface StatementLineSummary {
  readonly id: string;
  readonly importId: string;
  /** 1-based, counting the header, so it matches the row in the bursar's file. */
  readonly lineNumber: number;
  /** `YYYY-MM-DD`. The bank's value date, never rewritten. */
  readonly valueDate: string;
  readonly narrative: string;
  readonly reference: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly direction: BankStatementDirectionValue;
  readonly matchStatus: StatementLineMatchStatusValue;
  readonly matchedPaymentId: string | null;
  readonly matchedPaymentReference: string | null;
  readonly matchedStudentName: string | null;
  /** Null when the automatic pass matched it, which is itself worth showing. */
  readonly matchedByName: string | null;
  readonly matchedAt: string | null;
  readonly matchNote: string | null;
  readonly version: number;
}

/**
 * A payment a line might belong to.
 *
 * Suggestions are computed per request and never stored: a stored suggestion would go
 * stale the moment the payment it names is verified or cancelled, and a bursar acting on
 * a stale suggestion is exactly the failure this is meant to prevent.
 *
 * `amountMatches` is separate from the rest because it decides whether the match may be
 * made at all: a line and a payment of different amounts are not the same money.
 */
export interface StatementMatchSuggestion {
  readonly paymentId: string;
  readonly reference: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly studentNumber: string;
  readonly amount: string;
  readonly status: PaymentStatusValue;
  readonly payerName: string;
  readonly initiatedAt: string;
  /** Why this payment is being suggested, in words a bursar can check. */
  readonly reason: string;
  readonly amountMatches: boolean;
}

/** One imported statement. */
export interface StatementImportSummary {
  readonly id: string;
  readonly provider: PaymentProviderKeyValue;
  readonly accountLabel: string | null;
  readonly fileName: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly lineCount: number;
  readonly totalIn: string;
  readonly totalOut: string;
  readonly currency: string;
  readonly importedByName: string;
  readonly importedAt: string;
  readonly notes: string | null;
  /** How far through the work this statement is. Counted from the lines, not stored. */
  readonly matchedCount: number;
  readonly unmatchedCount: number;
  readonly ignoredCount: number;
  readonly ambiguousCount: number;
}

/**
 * The reconciliation worklist: lines awaiting a decision, and what each might belong to.
 *
 * Suggestions travel with the lines rather than being fetched per row, because a screen
 * that asked for candidates one line at a time would make a hundred requests to render a
 * month's statement — and a bursar would be reading the first row while the last was still
 * loading.
 */
export interface StatementLineWorklist {
  readonly lines: readonly StatementLineSummary[];
  /** Keyed by statement line id. Absent for a line with nothing to suggest. */
  readonly suggestions: Readonly<Record<string, readonly StatementMatchSuggestion[]>>;
}

/** A statement with its lines and, for each one, what it might belong to. */
export interface StatementImportDetail {
  readonly statement: StatementImportSummary;
  readonly lines: readonly StatementLineSummary[];
  /** Keyed by statement line id. Absent for a line with nothing to suggest. */
  readonly suggestions: Readonly<Record<string, readonly StatementMatchSuggestion[]>>;
}

/** One row of a statement as the preview reports it, before anything is stored. */
export interface StatementPreviewLine {
  readonly lineNumber: number;
  readonly valueDate: string | null;
  readonly narrative: string;
  readonly reference: string | null;
  readonly amount: string | null;
  readonly direction: BankStatementDirectionValue | null;
  /** What is wrong with the row, if anything. Empty for a row that will import. */
  readonly errors: readonly string[];
}

/**
 * What importing a file would do. Writes nothing.
 *
 * The same shape as the student import's preview, and for the same reason: a bursar sees
 * every problem in the file, against the row number they can see on screen, before
 * anything is stored (ADR-015).
 */
export interface StatementImportPreview {
  readonly fileName: string;
  readonly currency: string;
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly moneyInCount: number;
  readonly moneyOutCount: number;
  readonly totalIn: string;
  readonly totalOut: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** True when this exact file has already been imported. */
  readonly alreadyImported: boolean;
  readonly lines: readonly StatementPreviewLine[];
  readonly linesTruncated: boolean;
}

/** What an import actually did. */
export interface StatementImportResult {
  readonly statement: StatementImportSummary;
  /** Lines the automatic pass attributed: a quoted reference and an equal amount. */
  readonly automaticallyMatched: number;
  /** Lines with more than one candidate, left for a person. */
  readonly ambiguous: number;
}

/**
 * Where reconciliation stands for a period.
 *
 * Both sides are reported, because either one alone hides a problem: statement lines
 * nobody has attributed are money the school has but cannot explain, and live payments
 * with no statement line are claims the bank has not confirmed.
 */
export interface ReconciliationSummary {
  readonly from: string | null;
  readonly to: string | null;
  readonly currency: string;
  /**
   * Money-**in** lines only, across every decision.
   *
   * Money out is excluded throughout this summary on purpose: a bank charge or an outward
   * transfer is never a student's payment, so counting it as reconcilable work would make
   * the figures below look worse than the position actually is.
   */
  readonly statementLines: number;
  readonly matchedLines: number;
  readonly unmatchedLines: number;
  readonly ambiguousLines: number;
  readonly ignoredLines: number;
  readonly matchedTotal: string;
  readonly unmatchedTotal: string;
  /** Payments awaiting verification that no statement line has been matched to. */
  readonly unreconciledPayments: number;
  readonly unreconciledPaymentTotal: string;
}

/** What matching a line to a payment did. */
export interface StatementMatchResult {
  readonly line: StatementLineSummary;
  /** Present when the match also verified the payment and credited the ledger. */
  readonly payment: PaymentSummary | null;
  readonly credited: boolean;
  readonly message: string;
}

/**
 * The answer to a provider callback.
 *
 * Deliberately uninformative about *why* a callback was not accepted. A forged callback
 * must not learn whether it failed on the signature, the timestamp or the reference —
 * that is a verification oracle. The detail is recorded in `payment_webhook_events` and
 * the audit log, where the school can read it and an attacker cannot (Section 16).
 */
export interface WebhookAcknowledgement {
  readonly received: true;
}

/* ----------------------------------------------------------------- health check */

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface DependencyHealth {
  readonly name: string;
  readonly status: HealthStatus;
  readonly latencyMs?: number;
  /** Diagnostic summary only -- never includes connection strings or credentials. */
  readonly detail?: string;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  /** ISO-8601 UTC. */
  readonly timestamp: string;
  readonly uptimeSeconds: number;
  readonly dependencies: readonly DependencyHealth[];
}
