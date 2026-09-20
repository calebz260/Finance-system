/**
 * `/students`, `/guardians`, `/guardian-links` and `/enrolments`.
 *
 * One file because the permission story is one story: `student.*` and `guardian.*`
 * govern the same screens, and keeping the grants visible side by side is what makes
 * them reviewable against the matrix in `shared/src/authorization.ts`.
 *
 * The notable grants:
 *
 *  - **Reading a student** is `student.read`, which a Bursar holds — they cannot take
 *    a payment without finding the student first.
 *  - **Registering and importing** are `student.create` and `student.import`. Import
 *    is separate and marked sensitive, because one upload can create a thousand
 *    records and their guardians.
 *  - **Enrolment** is `academic.manage`: placing a student in a class is an academic
 *    decision, and it is what every later term charge is computed against.
 *  - **Guardian links carry financial rights**, so changing one needs `guardian.link`
 *    and a second factor. It decides who may see a balance and who may pay.
 */
import { Router } from 'express';

import { PermissionKey } from '@sfs/shared';

import { authenticate } from '../../middleware/authenticate.js';
import {
  requireMfaSatisfied,
  requirePermission,
  requireUsablePassword,
} from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import {
  endEnrollmentHandler,
  enrolStudentHandler,
  moveClassHandler,
} from '../enrollments/enrollment.controller.js';
import {
  endEnrollmentSchema,
  enrolStudentSchema,
  enrollmentIdParamsSchema,
  moveClassSchema,
} from '../enrollments/enrollment.schema.js';
import {
  createGuardianHandler,
  getGuardianHandler,
  linkGuardianHandler,
  listGuardiansHandler,
  unlinkGuardianHandler,
  updateGuardianHandler,
  updateLinkHandler,
} from '../guardians/guardian.controller.js';
import {
  createGuardianSchema,
  guardianIdParamsSchema,
  linkGuardianSchema,
  linkIdParamsSchema,
  listGuardiansQuerySchema,
  updateGuardianSchema,
  updateLinkSchema,
} from '../guardians/guardian.schema.js';
import {
  commitImportHandler,
  importUpload,
  previewImportHandler,
  translateUploadError,
} from '../imports/import.controller.js';
import {
  changeStudentStatusHandler,
  getStudentHandler,
  listStudentEnrollmentsHandler,
  listStudentGuardiansHandler,
  listStudentsHandler,
  registerStudentHandler,
  updateStudentHandler,
} from './student.controller.js';
import {
  changeStudentStatusSchema,
  listStudentsQuerySchema,
  registerStudentSchema,
  studentIdParamsSchema,
  updateStudentSchema,
} from './student.schema.js';

/**
 * Wrap the upload middleware so multer's own errors become the shared envelope rather
 * than an unhandled failure and a generic 500.
 */
function uploadSingleFile(): ReturnType<typeof importUpload.single> {
  const handler = importUpload.single('file');

  return (req, res, next) => {
    handler(req, res, (error: unknown) => {
      next(error === undefined || error === null ? undefined : translateUploadError(error));
    });
  };
}

export function createStudentRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(PermissionKey.STUDENT_READ),
    validate({ query: listStudentsQuerySchema }),
    listStudentsHandler,
  );

  router.post(
    '/',
    requirePermission(PermissionKey.STUDENT_CREATE),
    validate({ body: registerStudentSchema }),
    registerStudentHandler,
  );

  /* ------------------------------------------------------------ bulk import */

  // Declared before `/:studentId`, or "import" is parsed as an id.
  //
  // The preview needs only `student.read`: looking at what a file would do, without
  // writing anything, is not a privileged act. Committing needs `student.import`.
  router.post(
    '/import/preview',
    requirePermission(PermissionKey.STUDENT_READ),
    uploadSingleFile(),
    previewImportHandler,
  );

  router.post(
    '/import',
    requirePermission(PermissionKey.STUDENT_IMPORT),
    requireMfaSatisfied(),
    uploadSingleFile(),
    commitImportHandler,
  );

  /* --------------------------------------------------------------- one student */

  router.get(
    '/:studentId',
    requirePermission(PermissionKey.STUDENT_READ),
    validate({ params: studentIdParamsSchema }),
    getStudentHandler,
  );

  router.patch(
    '/:studentId',
    requirePermission(PermissionKey.STUDENT_UPDATE),
    validate({ params: studentIdParamsSchema, body: updateStudentSchema }),
    updateStudentHandler,
  );

  // Leaving the school is a lifecycle decision, not a field edit: it ends the live
  // enrolment too, and it carries the archive permission.
  router.put(
    '/:studentId/status',
    requirePermission(PermissionKey.STUDENT_ARCHIVE),
    validate({ params: studentIdParamsSchema, body: changeStudentStatusSchema }),
    changeStudentStatusHandler,
  );

  router.get(
    '/:studentId/guardians',
    requirePermission(PermissionKey.GUARDIAN_READ),
    validate({ params: studentIdParamsSchema }),
    listStudentGuardiansHandler,
  );

  router.post(
    '/:studentId/guardians',
    requirePermission(PermissionKey.GUARDIAN_LINK),
    requireMfaSatisfied(),
    validate({ params: studentIdParamsSchema, body: linkGuardianSchema }),
    linkGuardianHandler,
  );

  router.get(
    '/:studentId/enrolments',
    requirePermission(PermissionKey.STUDENT_READ),
    validate({ params: studentIdParamsSchema }),
    listStudentEnrollmentsHandler,
  );

  return router;
}

export function createGuardianRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(PermissionKey.GUARDIAN_READ),
    validate({ query: listGuardiansQuerySchema }),
    listGuardiansHandler,
  );

  router.post(
    '/',
    requirePermission(PermissionKey.GUARDIAN_CREATE),
    validate({ body: createGuardianSchema }),
    createGuardianHandler,
  );

  router.get(
    '/:guardianId',
    requirePermission(PermissionKey.GUARDIAN_READ),
    validate({ params: guardianIdParamsSchema }),
    getGuardianHandler,
  );

  router.patch(
    '/:guardianId',
    requirePermission(PermissionKey.GUARDIAN_UPDATE),
    validate({ params: guardianIdParamsSchema, body: updateGuardianSchema }),
    updateGuardianHandler,
  );

  return router;
}

/**
 * The link between a guardian and a student, addressed by its own id.
 *
 * Separate from `/guardians` because it is not a property of the guardian: the same
 * person may see one child's balance and not another's.
 */
export function createGuardianLinkRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.patch(
    '/:linkId',
    requirePermission(PermissionKey.GUARDIAN_LINK),
    requireMfaSatisfied(),
    validate({ params: linkIdParamsSchema, body: updateLinkSchema }),
    updateLinkHandler,
  );

  router.delete(
    '/:linkId',
    requirePermission(PermissionKey.GUARDIAN_LINK),
    requireMfaSatisfied(),
    validate({ params: linkIdParamsSchema }),
    unlinkGuardianHandler,
  );

  return router;
}

export function createEnrollmentRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.post(
    '/',
    requirePermission(PermissionKey.ACADEMIC_MANAGE),
    validate({ body: enrolStudentSchema }),
    enrolStudentHandler,
  );

  router.patch(
    '/:enrollmentId',
    requirePermission(PermissionKey.ACADEMIC_MANAGE),
    validate({ params: enrollmentIdParamsSchema, body: moveClassSchema }),
    moveClassHandler,
  );

  router.post(
    '/:enrollmentId/end',
    requirePermission(PermissionKey.ACADEMIC_MANAGE),
    validate({ params: enrollmentIdParamsSchema, body: endEnrollmentSchema }),
    endEnrollmentHandler,
  );

  return router;
}
