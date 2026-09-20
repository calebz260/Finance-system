/**
 * Academic-structure routes.
 *
 * The permission split is the substantive part. Reading the structure is `academic.read`,
 * which nearly every staff role holds — a bursar cannot record a payment without knowing
 * what class a student is in. Changing it is `academic.manage`, held by a School
 * Administrator and a DOS, because adding a term or a level changes what every later
 * fee structure and report is scoped by.
 *
 * Parents and students hold neither: they see their own records, not the school's
 * configuration.
 */
import { Router } from 'express';

import { PermissionKey } from '@sfs/shared';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireUsablePassword } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import {
  createAcademicYearHandler,
  createClassSectionHandler,
  createDepartmentHandler,
  createLevelHandler,
  createProgramHandler,
  createTermHandler,
  getCurrentAcademicYearHandler,
  listAcademicYearsHandler,
  listClassSectionsHandler,
  listDepartmentsHandler,
  listLevelsHandler,
  listProgramsHandler,
  setCurrentAcademicYearHandler,
  setCurrentTermHandler,
  setLevelProgressionHandler,
  updateAcademicYearHandler,
  updateClassSectionHandler,
  updateProgramHandler,
  updateTermHandler,
} from './academic.controller.js';
import {
  academicYearIdParamsSchema,
  classSectionIdParamsSchema,
  createAcademicYearSchema,
  createClassSectionSchema,
  createDepartmentSchema,
  createLevelSchema,
  createProgramSchema,
  createTermSchema,
  levelIdParamsSchema,
  listClassSectionsQuerySchema,
  listLevelsQuerySchema,
  listProgramsQuerySchema,
  programIdParamsSchema,
  setLevelProgressionSchema,
  termIdParamsSchema,
  updateAcademicYearSchema,
  updateClassSectionSchema,
  updateProgramSchema,
  updateTermSchema,
} from './academic.schema.js';

const READ = PermissionKey.ACADEMIC_READ;
const MANAGE = PermissionKey.ACADEMIC_MANAGE;

export function createAcademicYearRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get('/', requirePermission(READ), listAcademicYearsHandler);

  // Before `/:academicYearId`, or "current" would be read as an id and fail validation.
  router.get('/current', requirePermission(READ), getCurrentAcademicYearHandler);

  router.post(
    '/',
    requirePermission(MANAGE),
    validate({ body: createAcademicYearSchema }),
    createAcademicYearHandler,
  );

  router.patch(
    '/:academicYearId',
    requirePermission(MANAGE),
    validate({ params: academicYearIdParamsSchema, body: updateAcademicYearSchema }),
    updateAcademicYearHandler,
  );

  // A state change rather than a field edit: exactly one year is current, and the
  // switch clears the previous one in the same transaction.
  router.put(
    '/:academicYearId/current',
    requirePermission(MANAGE),
    validate({ params: academicYearIdParamsSchema }),
    setCurrentAcademicYearHandler,
  );

  return router;
}

export function createTermRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.post(
    '/',
    requirePermission(MANAGE),
    validate({ body: createTermSchema }),
    createTermHandler,
  );

  router.patch(
    '/:termId',
    requirePermission(MANAGE),
    validate({ params: termIdParamsSchema, body: updateTermSchema }),
    updateTermHandler,
  );

  router.put(
    '/:termId/current',
    requirePermission(MANAGE),
    validate({ params: termIdParamsSchema }),
    setCurrentTermHandler,
  );

  return router;
}

export function createDepartmentRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get('/', requirePermission(READ), listDepartmentsHandler);
  router.post(
    '/',
    requirePermission(MANAGE),
    validate({ body: createDepartmentSchema }),
    createDepartmentHandler,
  );

  return router;
}

export function createProgramRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(READ),
    validate({ query: listProgramsQuerySchema }),
    listProgramsHandler,
  );
  router.post(
    '/',
    requirePermission(MANAGE),
    validate({ body: createProgramSchema }),
    createProgramHandler,
  );
  router.patch(
    '/:programId',
    requirePermission(MANAGE),
    validate({ params: programIdParamsSchema, body: updateProgramSchema }),
    updateProgramHandler,
  );

  return router;
}

export function createLevelRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(READ),
    validate({ query: listLevelsQuerySchema }),
    listLevelsHandler,
  );
  router.post(
    '/',
    requirePermission(MANAGE),
    validate({ body: createLevelSchema }),
    createLevelHandler,
  );

  // The progression chain gets its own route because it is the thing promotion walks,
  // and it is validated against cycles rather than saved as an ordinary field.
  router.put(
    '/:levelId/next',
    requirePermission(MANAGE),
    validate({ params: levelIdParamsSchema, body: setLevelProgressionSchema }),
    setLevelProgressionHandler,
  );

  return router;
}

export function createClassSectionRouter(): Router {
  const router = Router();
  router.use(authenticate, requireUsablePassword());

  router.get(
    '/',
    requirePermission(READ),
    validate({ query: listClassSectionsQuerySchema }),
    listClassSectionsHandler,
  );
  router.post(
    '/',
    requirePermission(MANAGE),
    validate({ body: createClassSectionSchema }),
    createClassSectionHandler,
  );
  router.patch(
    '/:classSectionId',
    requirePermission(MANAGE),
    validate({ params: classSectionIdParamsSchema, body: updateClassSectionSchema }),
    updateClassSectionHandler,
  );

  return router;
}
