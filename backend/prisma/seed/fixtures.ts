/**
 * Development seed fixtures.
 *
 * Every name, phone number and address here is fictional and must stay that way: this
 * data lands in developer databases, screenshots and test output, so it must never
 * contain real personal information (Sections 24, 37).
 *
 * Phone numbers use the +25078 00 00 0xx range, which is reserved-looking and obviously
 * placeholder. Email addresses use `.invalid`, a reserved TLD that can never be
 * registered, so a stray notification cannot reach a real inbox.
 */
import { Gender, GuardianRelationship, ResidencyType } from '../../src/generated/prisma/enums.js';
import { RoleKey } from '@sfs/shared';

export const SCHOOL = {
  code: 'GSKICUKIRO',
  name: 'Groupe Scolaire de Kicukiro (Demo)',
  shortName: 'GS Kicukiro',
  motto: 'Knowledge and Integrity',
  email: 'info@gskicukiro.invalid',
  phone: '+250780000000',
  district: 'Kicukiro',
  sector: 'Gatenga',
  cell: 'Karambo',
  address: 'KK 15 Ave, Kicukiro, Kigali',
} as const;

/**
 * The single development password for every seeded account.
 *
 * Overridable with `SEED_PASSWORD`. Every seeded account is flagged
 * `mustChangePassword`, and the seed refuses to run when NODE_ENV is production, so this
 * value can never become a live credential.
 */
export const DEFAULT_SEED_PASSWORD = 'SfsDev!Password2026';

export interface UserFixture {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly roleKey: RoleKey;
  /** Super Administrator only: not scoped to a school. */
  readonly isSystemAdministrator?: boolean;
  /** Notes why the account exists, shown in the seed summary. */
  readonly note?: string;
}

export const USERS: readonly UserFixture[] = [
  {
    email: 'superadmin@sfs.invalid',
    firstName: 'System',
    lastName: 'Administrator',
    phone: '+250780000001',
    roleKey: RoleKey.SUPER_ADMIN,
    isSystemAdministrator: true,
    note: 'Cross-school technical administration',
  },
  {
    email: 'admin@gskicukiro.invalid',
    firstName: 'Chantal',
    lastName: 'Uwase',
    phone: '+250780000002',
    roleKey: RoleKey.SCHOOL_ADMIN,
    note: 'School configuration, users, academic structure',
  },
  {
    email: 'finance.manager@gskicukiro.invalid',
    firstName: 'Emmanuel',
    lastName: 'Habimana',
    phone: '+250780000003',
    roleKey: RoleKey.FINANCE_MANAGER,
    note: 'Approves adjustments, reversals and refunds',
  },
  {
    email: 'bursar@gskicukiro.invalid',
    firstName: 'Alice',
    lastName: 'Mukamana',
    phone: '+250780000004',
    roleKey: RoleKey.BURSAR,
    note: 'Records and verifies payments',
  },
  {
    email: 'bursar.two@gskicukiro.invalid',
    firstName: 'Jean',
    lastName: 'Nkurunziza',
    phone: '+250780000005',
    roleKey: RoleKey.BURSAR,
    note: 'Second bursar, so separation of duties on manual verification is testable',
  },
  {
    email: 'dos@gskicukiro.invalid',
    firstName: 'Beatrice',
    lastName: 'Nyirahabimana',
    phone: '+250780000006',
    roleKey: RoleKey.DOS,
    note: 'Student records and clearance status; no payment operations',
  },
  {
    email: 'parent@gskicukiro.invalid',
    firstName: 'Joseph',
    lastName: 'Bizimana',
    phone: '+250780000007',
    roleKey: RoleKey.PARENT,
    note: 'Parent portal account, linked to two students',
  },
  {
    email: 'student@gskicukiro.invalid',
    firstName: 'Diane',
    lastName: 'Ingabire',
    phone: '+250780000008',
    roleKey: RoleKey.STUDENT,
    note: 'Student self-service account',
  },
];

export interface DepartmentFixture {
  readonly code: string;
  readonly name: string;
  readonly description: string;
}

export const DEPARTMENTS: readonly DepartmentFixture[] = [
  { code: 'SCI', name: 'Sciences', description: 'Mathematics, physics, chemistry and biology' },
  { code: 'HUM', name: 'Humanities', description: 'Languages, history, geography and economics' },
  {
    code: 'TVET',
    name: 'Technical and Vocational',
    description: 'Trades and technical programmes',
  },
];

export interface LevelFixture {
  readonly code: string;
  readonly name: string;
  readonly sequence: number;
  readonly isTerminal: boolean;
}

export interface ProgramFixture {
  readonly code: string;
  readonly name: string;
  readonly departmentCode: string | null;
  readonly durationYears: number;
  readonly levels: readonly LevelFixture[];
}

/**
 * Programmes and their level chains.
 *
 * Note what is *not* modelled as a single chain: S3 is terminal for O'Level rather than
 * pointing at S4. Moving from O'Level to A'Level is a national-exam outcome plus a
 * programme choice, so it is a fresh enrolment in a different programme — not an
 * automatic promotion. Encoding it as a chain would let the promotion tool move a student
 * into a combination nobody selected.
 */
export const PROGRAMS: readonly ProgramFixture[] = [
  {
    code: 'OLEVEL',
    name: "Ordinary Level (O'Level)",
    departmentCode: null,
    durationYears: 3,
    levels: [
      { code: 'S1', name: 'Senior 1', sequence: 1, isTerminal: false },
      { code: 'S2', name: 'Senior 2', sequence: 2, isTerminal: false },
      { code: 'S3', name: 'Senior 3', sequence: 3, isTerminal: true },
    ],
  },
  {
    code: 'ALEVEL-MCB',
    name: 'Advanced Level — Mathematics, Chemistry, Biology',
    departmentCode: 'SCI',
    durationYears: 3,
    levels: [
      { code: 'S4', name: 'Senior 4 (MCB)', sequence: 1, isTerminal: false },
      { code: 'S5', name: 'Senior 5 (MCB)', sequence: 2, isTerminal: false },
      { code: 'S6', name: 'Senior 6 (MCB)', sequence: 3, isTerminal: true },
    ],
  },
  {
    code: 'ALEVEL-HEG',
    name: 'Advanced Level — History, Economics, Geography',
    departmentCode: 'HUM',
    durationYears: 3,
    levels: [
      { code: 'S4-HEG', name: 'Senior 4 (HEG)', sequence: 1, isTerminal: false },
      { code: 'S5-HEG', name: 'Senior 5 (HEG)', sequence: 2, isTerminal: false },
      { code: 'S6-HEG', name: 'Senior 6 (HEG)', sequence: 3, isTerminal: true },
    ],
  },
  {
    code: 'TVET-SOD',
    name: 'Software Development (TVET)',
    departmentCode: 'TVET',
    durationYears: 3,
    levels: [
      { code: 'L3', name: 'Level 3 — Software Development', sequence: 1, isTerminal: false },
      { code: 'L4', name: 'Level 4 — Software Development', sequence: 2, isTerminal: false },
      { code: 'L5', name: 'Level 5 — Software Development', sequence: 3, isTerminal: true },
    ],
  },
];

/* ------------------------------------------------------------ fees (Phase 4) */

export interface FeeCategoryFixture {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly sortOrder: number;
}

/**
 * The kinds of fee this school levies.
 *
 * Configuration, not code: another school's list differs, and this one changes without
 * wanting a release. Kept close to what a Rwandan secondary school actually charges.
 */
export const FEE_CATEGORIES: readonly FeeCategoryFixture[] = [
  { code: 'TUITION', name: 'Tuition', description: 'Termly teaching fee.', sortOrder: 1 },
  {
    code: 'REGISTRATION',
    name: 'Registration',
    description: 'Charged once per academic year on enrolment.',
    sortOrder: 2,
  },
  {
    code: 'BOARDING',
    name: 'Boarding',
    description: 'Accommodation and meals. Boarders only.',
    sortOrder: 3,
  },
  {
    code: 'EXAMINATION',
    name: 'Examination',
    description: 'Internal and national examination costs.',
    sortOrder: 4,
  },
  {
    code: 'PRACTICAL',
    name: 'Practical and laboratory',
    description: 'Consumables for laboratory and workshop sessions.',
    sortOrder: 5,
  },
  {
    code: 'MATERIALS',
    name: 'Learning materials',
    description: 'Books, handouts and stationery issued by the school.',
    sortOrder: 6,
  },
];

export interface FeeItemFixture {
  readonly categoryCode: string;
  readonly label: string;
  /** Decimal string. Never a number — see `shared/src/money.ts`. */
  readonly amount: string;
}

export interface FeeStructureFixture {
  readonly name: string;
  readonly description: string;
  /** Academic year name, matched against `ACADEMIC_YEARS`. */
  readonly academicYearName: string;
  /** Term name within that year, or null for a once-per-year fee. */
  readonly termName: string | null;
  /** Level code, or null to apply across every level. */
  readonly levelCode: string | null;
  readonly programCode: string | null;
  /** Restricts to boarders or day students. Null applies to both. */
  readonly residency: 'DAY' | 'BOARDING' | null;
  readonly items: readonly FeeItemFixture[];
}

/**
 * Fee structures for the current year, exercising every applicability axis the model
 * supports: a per-term level fee, a once-a-year registration fee with a null term, a
 * boarding fee restricted by residency, and a programme-wide practical fee.
 *
 * Amounts are realistic for a Rwandan day/boarding secondary school in RWF, and entirely
 * fictional.
 */
export const FEE_STRUCTURES: readonly FeeStructureFixture[] = [
  {
    name: 'Registration 2026',
    description: 'Charged once when a student enrols for the year.',
    academicYearName: '2026',
    termName: null,
    levelCode: null,
    programCode: null,
    residency: null,
    items: [{ categoryCode: 'REGISTRATION', label: 'Annual registration', amount: '15000.00' }],
  },
  {
    name: "O'Level tuition — Term 1 2026",
    description: 'Termly tuition and materials for S1–S3.',
    academicYearName: '2026',
    termName: 'Term 1',
    levelCode: null,
    programCode: 'OLEVEL',
    residency: null,
    items: [
      { categoryCode: 'TUITION', label: "Tuition — O'Level Term 1", amount: '95000.00' },
      { categoryCode: 'MATERIALS', label: 'Learning materials', amount: '12500.00' },
      { categoryCode: 'EXAMINATION', label: 'Termly examinations', amount: '8000.00' },
    ],
  },
  {
    name: 'Boarding — Term 1 2026',
    description: 'Accommodation and meals. Applies to boarders only.',
    academicYearName: '2026',
    termName: 'Term 1',
    levelCode: null,
    programCode: null,
    // The whole reason `Enrollment.residency` exists: a day student must never be
    // charged for a bed.
    residency: 'BOARDING',
    items: [{ categoryCode: 'BOARDING', label: 'Boarding — Term 1', amount: '140000.00' }],
  },
  {
    name: 'TVET practicals — Term 1 2026',
    description: 'Workshop consumables for Software Development.',
    academicYearName: '2026',
    termName: 'Term 1',
    levelCode: null,
    programCode: 'TVET-SOD',
    residency: null,
    items: [
      { categoryCode: 'TUITION', label: 'Tuition — TVET Term 1', amount: '105000.00' },
      { categoryCode: 'PRACTICAL', label: 'Workshop consumables', amount: '25000.00' },
    ],
  },
];

export interface ScholarshipFixture {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly sponsor: string;
  readonly defaultPercentage: string | null;
  readonly defaultAmount: string | null;
}

/** Named award programmes. Fictional sponsors. */
export const SCHOLARSHIPS: readonly ScholarshipFixture[] = [
  {
    code: 'DISTRICT-MERIT',
    name: 'District Merit Bursary',
    description: 'Awarded on national examination performance.',
    sponsor: 'Kicukiro District Education Office',
    defaultPercentage: '50.00',
    defaultAmount: null,
  },
  {
    code: 'STAFF-CHILD',
    name: 'Staff Child Award',
    description: 'For children of serving members of staff.',
    sponsor: 'School governing board',
    defaultPercentage: '25.00',
    defaultAmount: null,
  },
  {
    code: 'GIRLS-STEM',
    name: 'Girls in STEM Bursary',
    description: 'Supports girls continuing into science combinations.',
    sponsor: 'Rwanda STEM Trust (fictional)',
    defaultPercentage: null,
    defaultAmount: '75000.00',
  },
];

export interface TermFixture {
  readonly name: string;
  readonly sequence: number;
  readonly startDate: string;
  readonly endDate: string;
}

export interface AcademicYearFixture {
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  /** The year the system treats as "now". Exactly one fixture may set this. */
  readonly isCurrent: boolean;
  readonly terms: readonly TermFixture[];
  /** Sequence of the term that is current, when this is the current year. */
  readonly currentTermSequence?: number;
}

/**
 * Two academic years, so enrolment history is real rather than a single snapshot:
 * promotion, repetition, completion and withdrawal all need a previous year to have
 * happened.
 */
export const ACADEMIC_YEARS: readonly AcademicYearFixture[] = [
  {
    name: '2025',
    startDate: '2025-01-13',
    endDate: '2025-11-07',
    isCurrent: false,
    terms: [
      { name: 'Term 1', sequence: 1, startDate: '2025-01-13', endDate: '2025-04-04' },
      { name: 'Term 2', sequence: 2, startDate: '2025-04-21', endDate: '2025-07-11' },
      { name: 'Term 3', sequence: 3, startDate: '2025-07-28', endDate: '2025-11-07' },
    ],
  },
  {
    name: '2026',
    startDate: '2026-01-12',
    endDate: '2026-11-06',
    isCurrent: true,
    currentTermSequence: 3,
    terms: [
      { name: 'Term 1', sequence: 1, startDate: '2026-01-12', endDate: '2026-04-03' },
      { name: 'Term 2', sequence: 2, startDate: '2026-04-20', endDate: '2026-07-10' },
      { name: 'Term 3', sequence: 3, startDate: '2026-07-27', endDate: '2026-11-06' },
    ],
  },
];

/** Class sections created for each level, per academic year. */
export const CLASS_SECTION_CODES: Readonly<Record<string, readonly string[]>> = {
  S1: ['A', 'B'],
  S2: ['A', 'B'],
  S3: ['A'],
  S4: ['A'],
  S5: ['A'],
  S6: ['A'],
  'S4-HEG': ['A'],
  'S5-HEG': ['A'],
  'S6-HEG': ['A'],
  L3: ['A'],
  L4: ['A'],
  L5: ['A'],
};

export const CLASS_SECTION_CAPACITY = 45;

export interface StudentFixture {
  readonly firstName: string;
  readonly lastName: string;
  readonly gender: Gender;
  /** Year of birth; the day is fixed so the fixture is deterministic. */
  readonly birthYear: number;
  readonly residency: ResidencyType;
  /** Programme and level for the 2026 academic year. */
  readonly programCode: string;
  readonly levelCode: string;
  readonly classSectionCode: string;
  /** Year the student first joined; drives the Student ID. */
  readonly admissionYear: number;
  /**
   * What happened in 2025. `null` means the student is new in 2026 and has no prior
   * enrolment at this school.
   */
  readonly priorYear: {
    readonly levelCode: string;
    readonly programCode: string;
    readonly outcome: 'PROMOTED' | 'REPEATED' | 'COMPLETED' | 'WITHDRAWN' | 'TRANSFERRED_OUT';
  } | null;
  readonly guardianIndexes: readonly number[];
}

export interface GuardianFixture {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly occupation: string;
  readonly relationship: GuardianRelationship;
  /** Matches a USERS email when the guardian has a parent-portal account. */
  readonly userEmail?: string;
}

export const GUARDIANS: readonly GuardianFixture[] = [
  {
    firstName: 'Joseph',
    lastName: 'Bizimana',
    phone: '+250780000007',
    email: 'parent@gskicukiro.invalid',
    occupation: 'Teacher',
    relationship: GuardianRelationship.FATHER,
    userEmail: 'parent@gskicukiro.invalid',
  },
  {
    firstName: 'Immaculee',
    lastName: 'Mukandayisenga',
    phone: '+250780000010',
    email: 'guardian10@gskicukiro.invalid',
    occupation: 'Trader',
    relationship: GuardianRelationship.MOTHER,
  },
  {
    firstName: 'Patrick',
    lastName: 'Rwigema',
    phone: '+250780000011',
    email: null,
    occupation: 'Driver',
    relationship: GuardianRelationship.FATHER,
  },
  {
    firstName: 'Josiane',
    lastName: 'Nyiraneza',
    phone: '+250780000012',
    email: 'guardian12@gskicukiro.invalid',
    occupation: 'Nurse',
    relationship: GuardianRelationship.MOTHER,
  },
  {
    firstName: 'Eric',
    lastName: 'Munyaneza',
    phone: '+250780000013',
    email: null,
    occupation: 'Civil servant',
    relationship: GuardianRelationship.GUARDIAN,
  },
  {
    firstName: 'Specioza',
    lastName: 'Kampire',
    phone: '+250780000014',
    email: 'guardian14@gskicukiro.invalid',
    occupation: 'Farmer',
    relationship: GuardianRelationship.MOTHER,
  },
  {
    firstName: 'Fidele',
    lastName: 'Ndayisaba',
    phone: '+250780000015',
    email: null,
    occupation: 'Mechanic',
    relationship: GuardianRelationship.FATHER,
  },
  {
    firstName: 'Claudine',
    lastName: 'Uwimana',
    phone: '+250780000016',
    email: 'guardian16@gskicukiro.invalid',
    occupation: 'Tailor',
    relationship: GuardianRelationship.MOTHER,
  },
];

const F = Gender.FEMALE;
const M = Gender.MALE;
const DAY = ResidencyType.DAY;
const BOARDING = ResidencyType.BOARDING;

/**
 * Students.
 *
 * Chosen to exercise the lifecycle rather than merely to fill a table: continuing
 * students, a repeat, a new intake, a student who completed O'Level and re-enrolled into
 * A'Level, a withdrawal, a transfer out, and both day and boarding residency (which will
 * attract different fees in Phase 4). Two students share guardian 0, whose parent-portal
 * account therefore sees two children.
 */
export const STUDENTS: readonly StudentFixture[] = [
  // --- continuing students, promoted from 2025
  {
    firstName: 'Diane',
    lastName: 'Ingabire',
    gender: F,
    birthYear: 2010,
    residency: BOARDING,
    programCode: 'OLEVEL',
    levelCode: 'S3',
    classSectionCode: 'A',
    admissionYear: 2024,
    priorYear: { levelCode: 'S2', programCode: 'OLEVEL', outcome: 'PROMOTED' },
    guardianIndexes: [0],
  },
  {
    firstName: 'Kevin',
    lastName: 'Bizimana',
    gender: M,
    birthYear: 2012,
    residency: DAY,
    programCode: 'OLEVEL',
    levelCode: 'S1',
    classSectionCode: 'A',
    admissionYear: 2026,
    priorYear: null,
    guardianIndexes: [0],
  },
  {
    firstName: 'Aline',
    lastName: 'Mutesi',
    gender: F,
    birthYear: 2011,
    residency: DAY,
    programCode: 'OLEVEL',
    levelCode: 'S2',
    classSectionCode: 'A',
    admissionYear: 2025,
    priorYear: { levelCode: 'S1', programCode: 'OLEVEL', outcome: 'PROMOTED' },
    guardianIndexes: [1],
  },
  {
    firstName: 'Olivier',
    lastName: 'Rwigema',
    gender: M,
    birthYear: 2011,
    residency: BOARDING,
    programCode: 'OLEVEL',
    levelCode: 'S2',
    classSectionCode: 'B',
    admissionYear: 2025,
    priorYear: { levelCode: 'S1', programCode: 'OLEVEL', outcome: 'PROMOTED' },
    guardianIndexes: [2],
  },
  {
    firstName: 'Sandrine',
    lastName: 'Nyiraneza',
    gender: F,
    birthYear: 2010,
    residency: DAY,
    programCode: 'OLEVEL',
    levelCode: 'S3',
    classSectionCode: 'A',
    admissionYear: 2024,
    priorYear: { levelCode: 'S2', programCode: 'OLEVEL', outcome: 'PROMOTED' },
    guardianIndexes: [3],
  },

  // --- a repeat: same level again in 2026
  {
    firstName: 'Thierry',
    lastName: 'Munyaneza',
    gender: M,
    birthYear: 2011,
    residency: DAY,
    programCode: 'OLEVEL',
    levelCode: 'S2',
    classSectionCode: 'B',
    admissionYear: 2024,
    priorYear: { levelCode: 'S2', programCode: 'OLEVEL', outcome: 'REPEATED' },
    guardianIndexes: [4],
  },

  // --- completed O'Level in 2025, re-enrolled into A'Level in 2026
  {
    firstName: 'Clarisse',
    lastName: 'Kampire',
    gender: F,
    birthYear: 2009,
    residency: BOARDING,
    programCode: 'ALEVEL-MCB',
    levelCode: 'S4',
    classSectionCode: 'A',
    admissionYear: 2023,
    priorYear: { levelCode: 'S3', programCode: 'OLEVEL', outcome: 'COMPLETED' },
    guardianIndexes: [5],
  },
  {
    firstName: 'Fabrice',
    lastName: 'Ndayisaba',
    gender: M,
    birthYear: 2009,
    residency: DAY,
    programCode: 'ALEVEL-HEG',
    levelCode: 'S4-HEG',
    classSectionCode: 'A',
    admissionYear: 2023,
    priorYear: { levelCode: 'S3', programCode: 'OLEVEL', outcome: 'COMPLETED' },
    guardianIndexes: [6],
  },

  // --- A'Level continuing
  {
    firstName: 'Yvette',
    lastName: 'Uwimana',
    gender: F,
    birthYear: 2008,
    residency: BOARDING,
    programCode: 'ALEVEL-MCB',
    levelCode: 'S5',
    classSectionCode: 'A',
    admissionYear: 2022,
    priorYear: { levelCode: 'S4', programCode: 'ALEVEL-MCB', outcome: 'PROMOTED' },
    guardianIndexes: [7],
  },
  {
    firstName: 'Samuel',
    lastName: 'Habyarimana',
    gender: M,
    birthYear: 2007,
    residency: DAY,
    programCode: 'ALEVEL-MCB',
    levelCode: 'S6',
    classSectionCode: 'A',
    admissionYear: 2021,
    priorYear: { levelCode: 'S5', programCode: 'ALEVEL-MCB', outcome: 'PROMOTED' },
    guardianIndexes: [1],
  },
  {
    firstName: 'Nadine',
    lastName: 'Umutoni',
    gender: F,
    birthYear: 2008,
    residency: DAY,
    programCode: 'ALEVEL-HEG',
    levelCode: 'S5-HEG',
    classSectionCode: 'A',
    admissionYear: 2022,
    priorYear: { levelCode: 'S4-HEG', programCode: 'ALEVEL-HEG', outcome: 'PROMOTED' },
    guardianIndexes: [3],
  },

  // --- TVET
  {
    firstName: 'Innocent',
    lastName: 'Gatete',
    gender: M,
    birthYear: 2009,
    residency: DAY,
    programCode: 'TVET-SOD',
    levelCode: 'L4',
    classSectionCode: 'A',
    admissionYear: 2025,
    priorYear: { levelCode: 'L3', programCode: 'TVET-SOD', outcome: 'PROMOTED' },
    guardianIndexes: [4],
  },
  {
    firstName: 'Josiane',
    lastName: 'Byukusenge',
    gender: F,
    birthYear: 2008,
    residency: BOARDING,
    programCode: 'TVET-SOD',
    levelCode: 'L5',
    classSectionCode: 'A',
    admissionYear: 2024,
    priorYear: { levelCode: 'L4', programCode: 'TVET-SOD', outcome: 'PROMOTED' },
    guardianIndexes: [5],
  },
  {
    firstName: 'Pacifique',
    lastName: 'Nsengimana',
    gender: M,
    birthYear: 2010,
    residency: DAY,
    programCode: 'TVET-SOD',
    levelCode: 'L3',
    classSectionCode: 'A',
    admissionYear: 2026,
    priorYear: null,
    guardianIndexes: [6],
  },

  // --- new 2026 intake
  {
    firstName: 'Gisele',
    lastName: 'Mukamurenzi',
    gender: F,
    birthYear: 2012,
    residency: DAY,
    programCode: 'OLEVEL',
    levelCode: 'S1',
    classSectionCode: 'A',
    admissionYear: 2026,
    priorYear: null,
    guardianIndexes: [7],
  },
  {
    firstName: 'Eric',
    lastName: 'Tuyishime',
    gender: M,
    birthYear: 2012,
    residency: BOARDING,
    programCode: 'OLEVEL',
    levelCode: 'S1',
    classSectionCode: 'B',
    admissionYear: 2026,
    priorYear: null,
    guardianIndexes: [2],
  },
  {
    firstName: 'Consolee',
    lastName: 'Nirere',
    gender: F,
    birthYear: 2012,
    residency: DAY,
    programCode: 'OLEVEL',
    levelCode: 'S1',
    classSectionCode: 'B',
    admissionYear: 2026,
    priorYear: null,
    guardianIndexes: [1],
  },
];

/**
 * Former students: they have no 2026 enrolment, and must not be counted in the current
 * population (Section 11). They remain searchable, and their financial history is
 * retained for clearance checks (Section 20).
 */
export const FORMER_STUDENTS: readonly StudentFixture[] = [
  {
    firstName: 'Jeanette',
    lastName: 'Mukandutiye',
    gender: F,
    birthYear: 2008,
    residency: DAY,
    programCode: 'OLEVEL',
    levelCode: 'S3',
    classSectionCode: 'A',
    admissionYear: 2023,
    priorYear: { levelCode: 'S3', programCode: 'OLEVEL', outcome: 'WITHDRAWN' },
    guardianIndexes: [3],
  },
  {
    firstName: 'Bosco',
    lastName: 'Sibomana',
    gender: M,
    birthYear: 2009,
    residency: DAY,
    programCode: 'OLEVEL',
    levelCode: 'S2',
    classSectionCode: 'A',
    admissionYear: 2024,
    priorYear: { levelCode: 'S2', programCode: 'OLEVEL', outcome: 'TRANSFERRED_OUT' },
    guardianIndexes: [6],
  },
];
