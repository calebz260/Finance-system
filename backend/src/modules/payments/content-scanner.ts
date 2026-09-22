/**
 * Whether an uploaded file's bytes were checked for malicious content.
 *
 * A port, not an implementation, for the same reason `password-delivery.ts` is one: the
 * thing that would actually scan a file is an external service the school has to provide,
 * and inventing a scanner here would be worse than admitting there is none.
 *
 * What matters is that the *absence* of a scanner is recorded as a fact. `SKIPPED` is
 * written to `payment_evidence.scan_state` and shown to the reviewer, so a bursar opening
 * a bank slip can tell an unscanned file from a clean one. The alternative — defaulting
 * unscanned files to CLEAN, or leaving the column null and hoping — would turn a missing
 * control into an invisible one, which is the failure mode this whole column exists to
 * prevent (Section 23, docs/SECURITY.md).
 *
 * The one behaviour that is not deferred: an `INFECTED` verdict deletes the bytes and
 * refuses the upload, so no row ever points at a file a scanner objected to. That is
 * implemented in `evidence.service.ts` and does not depend on which scanner reported it.
 */
import type { ContentScanState } from '../../generated/prisma/enums.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('payments.content-scanner');

export interface ScanRequest {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface ContentScanner {
  /** Never throws for an ordinary verdict; a scanner that is unreachable returns PENDING. */
  scan(request: ScanRequest): Promise<ContentScanState>;
}

/**
 * The scanner in force until a school supplies one.
 *
 * Reports `SKIPPED` — honestly, every time. It does not log per upload: with no scanner
 * configured that would be one warning per bank slip, which trains operators to ignore
 * the log. The deployment-level fact is logged once, when the scanner is first resolved.
 */
export class NoContentScanner implements ContentScanner {
  scan(): Promise<ContentScanState> {
    return Promise.resolve('SKIPPED');
  }
}

let scanner: ContentScanner | null = null;

/**
 * The configured scanner.
 *
 * Resolved once per process. A real adapter is registered through `setContentScanner`
 * during start-up when one exists, which is also how a test substitutes an infected
 * verdict without a scanning service.
 */
export function contentScanner(): ContentScanner {
  if (scanner === null) {
    scanner = new NoContentScanner();
    log.warn(
      'No malware scanner is configured. Uploaded proof of payment is stored and recorded ' +
        'as SKIPPED rather than scanned.',
    );
  }
  return scanner;
}

/** Install a scanner. Called from start-up wiring, and from tests. */
export function setContentScanner(next: ContentScanner | null): void {
  scanner = next;
}
