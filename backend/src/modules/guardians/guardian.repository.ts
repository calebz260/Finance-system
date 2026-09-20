/**
 * Guardian data access, and the link between a guardian and a student.
 *
 * The link is the interesting table. It is not a join row: it carries the financial
 * rights Section 26 turns into authorisation checks — who may see a balance, who may
 * pay, who the school rings first. Those flags are read on every parent-portal request
 * in Phase 5 onward, so they live here rather than being inferred from a relationship
 * label.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { GuardianRelationship } from '../../generated/prisma/enums.js';
import type { AccessScope } from '../../lib/access-scope.js';
import type { ResolvedPagination } from '../../lib/http.js';
import { requireVersionedUpdate } from '../../lib/optimistic-lock.js';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';

const GUARDIAN_PROJECTION = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  altPhone: true,
  email: true,
  nationalIdNumber: true,
  occupation: true,
  district: true,
  sector: true,
  address: true,
  userId: true,
  version: true,
  _count: { select: { students: true } },
} as const satisfies Prisma.GuardianSelect;

const LINK_PROJECTION = {
  id: true,
  guardianId: true,
  studentId: true,
  relationship: true,
  isPrimaryContact: true,
  isFinanciallyResponsible: true,
  canViewFinancials: true,
  canInitiatePayments: true,
  version: true,
  guardian: { select: { firstName: true, lastName: true, phone: true } },
} as const satisfies Prisma.StudentGuardianSelect;

export type GuardianRecord = Prisma.GuardianGetPayload<{ select: typeof GUARDIAN_PROJECTION }>;
export type GuardianLinkRecord = Prisma.StudentGuardianGetPayload<{
  select: typeof LINK_PROJECTION;
}>;

export interface GuardianListFilters {
  readonly search?: string | undefined;
}

export interface CreateGuardianInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly altPhone?: string | null;
  readonly email?: string | null;
  readonly nationalIdNumber?: string | null;
  readonly occupation?: string | null;
  readonly district?: string | null;
  readonly sector?: string | null;
  readonly address?: string | null;
}

export interface LinkInput {
  readonly studentId: string;
  readonly guardianId: string;
  readonly relationship: GuardianRelationship;
  readonly isPrimaryContact: boolean;
  readonly isFinanciallyResponsible: boolean;
  readonly canViewFinancials: boolean;
  readonly canInitiatePayments: boolean;
}

export class GuardianRepository {
  constructor(private readonly db: PrismaTransactionClient = prisma) {}

  withTransaction(tx: PrismaTransactionClient): GuardianRepository {
    return new GuardianRepository(tx);
  }

  async findById(scope: AccessScope, id: string): Promise<GuardianRecord | null> {
    return this.db.guardian.findFirst({ where: scope.where({ id }), select: GUARDIAN_PROJECTION });
  }

  /**
   * Find a guardian by phone number within the school.
   *
   * The phone number is how the importer recognises that the same parent appears on
   * four children's rows. It is not unique in the schema — two guardians can genuinely
   * share a household line — so this returns the first match and the caller decides.
   */
  async findByPhone(scope: AccessScope, phone: string): Promise<GuardianRecord | null> {
    return this.db.guardian.findFirst({
      where: scope.where({ phone }),
      select: GUARDIAN_PROJECTION,
    });
  }

  async list(
    scope: AccessScope,
    filters: GuardianListFilters,
    pagination: ResolvedPagination,
  ): Promise<{ items: GuardianRecord[]; totalItems: number }> {
    const where: Prisma.GuardianWhereInput = { ...scope.filter };

    if (filters.search !== undefined && filters.search.trim() !== '') {
      const term = filters.search.trim();
      where.OR = [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term } },
        { email: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [items, totalItems] = await Promise.all([
      this.db.guardian.findMany({
        where,
        select: GUARDIAN_PROJECTION,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.db.guardian.count({ where }),
    ]);

    return { items, totalItems };
  }

  async create(scope: AccessScope, input: CreateGuardianInput): Promise<GuardianRecord> {
    return this.db.guardian.create({
      data: {
        schoolId: scope.requireSchoolId(),
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        altPhone: input.altPhone ?? null,
        email: input.email ?? null,
        nationalIdNumber: input.nationalIdNumber ?? null,
        occupation: input.occupation ?? null,
        district: input.district ?? null,
        sector: input.sector ?? null,
        address: input.address ?? null,
      },
      select: GUARDIAN_PROJECTION,
    });
  }

  async update(
    scope: AccessScope,
    args: { id: string; expectedVersion: number; changes: Partial<CreateGuardianInput> },
  ): Promise<GuardianRecord> {
    await requireVersionedUpdate(
      this.db.guardian.updateMany({
        where: scope.where({ id: args.id, version: args.expectedVersion }),
        data: { ...args.changes, version: { increment: 1 } },
      }),
      'guardian',
    );

    const updated = await this.findById(scope, args.id);
    if (updated === null) throw new Error(`Guardian ${args.id} vanished after a successful update`);
    return updated;
  }

  /* ----------------------------------------------------------------- linking */

  async findLink(
    scope: AccessScope,
    args: { studentId: string; guardianId: string },
  ): Promise<GuardianLinkRecord | null> {
    return this.db.studentGuardian.findFirst({
      where: scope.where(args),
      select: LINK_PROJECTION,
    });
  }

  async findLinkById(scope: AccessScope, id: string): Promise<GuardianLinkRecord | null> {
    return this.db.studentGuardian.findFirst({
      where: scope.where({ id }),
      select: LINK_PROJECTION,
    });
  }

  async listLinksForStudent(scope: AccessScope, studentId: string): Promise<GuardianLinkRecord[]> {
    return this.db.studentGuardian.findMany({
      where: scope.where({ studentId }),
      select: LINK_PROJECTION,
      orderBy: [{ isPrimaryContact: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async link(scope: AccessScope, input: LinkInput): Promise<GuardianLinkRecord> {
    return this.db.studentGuardian.create({
      data: { schoolId: scope.requireSchoolId(), ...input },
      select: LINK_PROJECTION,
    });
  }

  async updateLink(
    scope: AccessScope,
    args: {
      id: string;
      expectedVersion: number;
      changes: {
        relationship?: GuardianRelationship;
        isPrimaryContact?: boolean;
        isFinanciallyResponsible?: boolean;
        canViewFinancials?: boolean;
        canInitiatePayments?: boolean;
      };
    },
  ): Promise<GuardianLinkRecord> {
    await requireVersionedUpdate(
      this.db.studentGuardian.updateMany({
        where: scope.where({ id: args.id, version: args.expectedVersion }),
        data: { ...args.changes, version: { increment: 1 } },
      }),
      'guardian link',
    );

    const updated = await this.findLinkById(scope, args.id);
    if (updated === null) throw new Error(`Link ${args.id} vanished after a successful update`);
    return updated;
  }

  async unlink(scope: AccessScope, id: string): Promise<boolean> {
    const result = await this.db.studentGuardian.deleteMany({ where: scope.where({ id }) });
    return result.count > 0;
  }

  /**
   * Clear the primary-contact flag from a student's other guardians.
   *
   * Called inside the same transaction as setting a new one, so a student never has
   * two people the school considers the first to ring.
   */
  async clearPrimaryContact(
    scope: AccessScope,
    args: { studentId: string; exceptLinkId?: string },
  ): Promise<void> {
    await this.db.studentGuardian.updateMany({
      where: scope.where({
        studentId: args.studentId,
        isPrimaryContact: true,
        ...(args.exceptLinkId !== undefined ? { id: { not: args.exceptLinkId } } : {}),
      }),
      data: { isPrimaryContact: false },
    });
  }
}

export const guardianRepository = new GuardianRepository();
