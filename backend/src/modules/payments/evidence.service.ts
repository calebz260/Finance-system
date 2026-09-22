/**
 * Proof of payment: upload, supersede, and an authenticated download.
 *
 * A bank slip is not an attachment; it is the evidence behind a credit to a family's
 * account, and the rules here follow from that:
 *
 *  - **Nothing is overwritten.** Replacing a slip inserts a new row and marks the old one
 *    superseded, so "the evidence changed after the bursar looked at it" is a visible
 *    fact rather than an invisible one (Section 23).
 *  - **Evidence can only be added while a decision is still outstanding.** Once a payment
 *    is credited, failed or cancelled, the file that would have justified it is no longer
 *    evidence of anything — and allowing an upload afterwards would let the record behind
 *    a settled credit be restyled after the fact.
 *  - **There is no URL.** The file comes back from an endpoint that re-checks who is
 *    asking, on every request, so a link cannot be forwarded to somebody who may not see
 *    it. Every download is audited, because "who looked at this family's bank slip?" is a
 *    question the school should be able to answer (Section 22).
 *  - **An infected file never reaches the database.** The bytes are deleted and the
 *    upload is refused, so no row can point at a file a scanner objected to.
 */
import { ErrorCode, type PaymentEvidenceKindValue, type PaymentEvidenceSummary } from '@sfs/shared';

import type { PaymentStatus } from '../../generated/prisma/enums.js';
import { DomainError, NotFoundError } from '../../lib/errors.js';
import {
  discardStoredFile,
  readStoredFile,
  storeUploadedFile,
  UnsupportedFileError,
} from '../../lib/file-storage.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { AuditAction, AuditEntity } from '../audit/audit.actions.js';
import { record } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { contentScanner } from './content-scanner.js';
import { isStaffReader, resolveStudentFinancialAccess } from './payment.access.js';
import { toEvidenceSummary } from './payment.presenter.js';
import { paymentRepository, type PaymentRecord } from './payment.repository.js';
import { loadReadablePayment } from './payment.service.js';

const log = createLogger('payments.evidence');

/**
 * The statuses that may still gain evidence.
 *
 * The three live ones, and only those. A payment held for review is included on purpose:
 * asking the payer for a clearer photograph of the slip is the most common way a review
 * is actually resolved.
 */
const ACCEPTS_EVIDENCE: readonly PaymentStatus[] = ['PENDING', 'PROCESSING', 'REQUIRES_REVIEW'];

function assertAcceptsEvidence(payment: PaymentRecord): void {
  if (ACCEPTS_EVIDENCE.includes(payment.status)) return;

  throw new DomainError(
    ErrorCode.PRECONDITION_FAILED,
    'This payment has already been decided, so proof of payment can no longer be attached ' +
      'to it. Contact the bursar’s office with your payment reference.',
    { details: { status: payment.status } },
  );
}

export interface UploadEvidenceInput {
  readonly kind: PaymentEvidenceKindValue;
  readonly bytes: Buffer;
  /** As the uploader's browser named it. Shown to a reviewer, never used as a path. */
  readonly originalName: string;
  /** The browser's claim about the content. A hint, never the decision. */
  readonly declaredContentType: string | null;
}

/**
 * Attach proof of payment to a claim.
 *
 * The file is written first and the row second, which means a failure between the two
 * leaves an unreferenced file on disk. That is the right way round: the file is inert
 * without a row pointing at it, whereas a row pointing at a file that was never written
 * is a reviewer clicking Download and getting an error on evidence the system claims to
 * hold.
 */
export async function uploadEvidence(
  principal: Principal,
  paymentId: string,
  input: UploadEvidenceInput,
): Promise<PaymentEvidenceSummary> {
  const payment = await loadReadablePayment(principal, paymentId);
  assertAcceptsEvidence(payment);

  if (!isStaffReader(principal)) {
    // A parent submitting their own slip needs the right to have made the claim.
    await resolveStudentFinancialAccess(principal, payment.studentId, 'INITIATE');
  }

  const fileName = sanitiseFileName(input.originalName);

  const stored = await storeUploadedFile({
    bytes: input.bytes,
    declaredContentType: input.declaredContentType,
  });

  const scanState = await contentScanner().scan({
    bytes: input.bytes,
    contentType: stored.contentType,
    byteSize: stored.byteSize,
  });

  if (scanState === 'INFECTED') {
    await discardStoredFile(stored.storageKey);

    await record({
      action: AuditAction.EVIDENCE_REJECTED,
      entityType: AuditEntity.PAYMENT_EVIDENCE,
      entityId: null,
      result: 'FAILURE',
      schoolId: payment.schoolId,
      actorUserId: principal.userId,
      reason: 'The malware scanner reported the uploaded file as infected.',
      metadata: {
        paymentId: payment.id,
        reference: payment.reference,
        checksum: stored.checksum,
        contentType: stored.contentType,
      },
    });

    log.error(
      { paymentId: payment.id, checksum: stored.checksum },
      'Refused an uploaded evidence file reported as infected',
    );

    throw new UnsupportedFileError(
      'That file was rejected by the malware scanner and has not been kept.',
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    // One current document per kind. A second bank slip replaces the first rather than
    // sitting beside it, so a reviewer is never guessing which of two slips is the one
    // being claimed against — and the first is still on the record.
    const superseded = await paymentRepository.supersedeEvidence(
      { paymentId: payment.id, kind: input.kind },
      tx,
    );

    const evidence = await paymentRepository.createEvidence(
      {
        schoolId: payment.schoolId,
        paymentId: payment.id,
        kind: input.kind,
        storageKey: stored.storageKey,
        fileName,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        checksum: stored.checksum,
        scanState,
        uploadedByUserId: principal.userId,
      },
      tx,
    );

    if (superseded > 0) {
      await record(
        {
          action: AuditAction.EVIDENCE_SUPERSEDED,
          entityType: AuditEntity.PAYMENT_EVIDENCE,
          entityId: evidence.id,
          schoolId: payment.schoolId,
          actorUserId: principal.userId,
          reason: 'A newer document of the same kind was uploaded.',
          metadata: { paymentId: payment.id, kind: input.kind, supersededCount: superseded },
        },
        tx,
      );
    }

    await record(
      {
        action: AuditAction.EVIDENCE_UPLOADED,
        entityType: AuditEntity.PAYMENT_EVIDENCE,
        entityId: evidence.id,
        schoolId: payment.schoolId,
        actorUserId: principal.userId,
        afterState: {
          paymentId: payment.id,
          reference: payment.reference,
          kind: input.kind,
          fileName,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          checksum: stored.checksum,
          scanState,
        },
      },
      tx,
    );

    return evidence;
  });

  log.info(
    {
      paymentId: payment.id,
      evidenceId: created.id,
      kind: input.kind,
      byteSize: stored.byteSize,
      scanState,
    },
    'Proof of payment attached to a payment claim',
  );

  return toEvidenceSummary(created);
}

export interface EvidenceDownload {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

/**
 * Serve one evidence file to a caller entitled to see it.
 *
 * The payment is authorised first, then the evidence is checked to belong to that payment.
 * Doing it in that order matters: an evidence id from another payment must not be readable
 * by quoting a payment the caller *can* see.
 */
export async function downloadEvidence(
  principal: Principal,
  paymentId: string,
  evidenceId: string,
): Promise<EvidenceDownload> {
  const payment = await loadReadablePayment(principal, paymentId);

  const evidence = await paymentRepository.findEvidenceById(evidenceId);
  if (evidence === null) {
    throw new NotFoundError('That document was not found on this payment.');
  }
  // The same refusal for a document that belongs to a different payment, so an evidence
  // id cannot be probed by quoting a payment the caller is allowed to see.
  if (evidence.paymentId !== payment.id) {
    throw new NotFoundError('That document was not found on this payment.');
  }
  // The evidence carries its own school. Re-checked rather than inferred from the payment,
  // so a mis-parented row cannot become a way across a tenant boundary.
  principal.scope.assertPermits(evidence, 'document');

  if (evidence.scanState === 'INFECTED') {
    // Unreachable through `uploadEvidence`, which never creates such a row. Handled
    // because a scanner may be run again later over stored files, and the answer to
    // "may I download the infected one?" must be no wherever the verdict came from.
    throw new DomainError(
      ErrorCode.PRECONDITION_FAILED,
      'That document was flagged by the malware scanner and cannot be downloaded.',
    );
  }

  const bytes = await readStoredFile(evidence.storageKey);

  await record({
    action: AuditAction.EVIDENCE_DOWNLOADED,
    entityType: AuditEntity.PAYMENT_EVIDENCE,
    entityId: evidence.id,
    schoolId: payment.schoolId,
    actorUserId: principal.userId,
    metadata: {
      paymentId: payment.id,
      reference: payment.reference,
      fileName: evidence.fileName,
      // Recorded so an access review can tell staff reads from a parent re-reading their
      // own slip without joining against the roles table.
      readAs: isStaffReader(principal) ? 'STAFF' : 'SELF_SERVICE',
    },
  });

  return { fileName: evidence.fileName, contentType: evidence.contentType, bytes };
}

/** Everything attached to a payment, newest first. */
export async function listEvidence(
  principal: Principal,
  paymentId: string,
): Promise<readonly PaymentEvidenceSummary[]> {
  const payment = await loadReadablePayment(principal, paymentId);
  const evidence = await paymentRepository.listEvidenceForPayment(payment.id);
  return evidence.map(toEvidenceSummary);
}

/**
 * A display name that is safe to keep and safe to send back.
 *
 * The uploaded name is never used as a path — the stored key is server-generated — but it
 * *is* shown to a reviewer and echoed in a `Content-Disposition` header, so directory
 * separators, control characters and quotes come out, and the length is capped.
 */
function sanitiseFileName(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? '';
  // Control characters are exactly what is being removed here, which is why the rule is
  // disabled rather than the pattern softened: a newline in this string would let a
  // filename forge a second response header.
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();

  if (cleaned === '') return 'proof-of-payment';
  return cleaned.slice(0, 120);
}
