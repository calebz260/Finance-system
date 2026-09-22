/**
 * Storage for uploaded proof of payment.
 *
 * Phase 3 deliberately parsed import files in memory and threw them away (ADR-017),
 * leaving persistent file handling to the phase that actually needs it. This is that
 * phase: a bank slip is evidence behind a credit to a family's account, and it has to
 * still be there when somebody asks about that credit years later.
 *
 * Four properties are load-bearing, and each of them is a decision about a real attack or
 * a real mistake:
 *
 *  - **The stored name is server-generated and opaque.** Never the uploaded filename,
 *    which is attacker-controlled: `../../etc/passwd`, a 300-character name, a name
 *    differing from another only by case on a case-insensitive filesystem. A random
 *    32-byte key laid out as `ab/<62 hex>.<ext>` cannot traverse, cannot collide and
 *    cannot be guessed — and the same shape is enforced by a database check constraint,
 *    so a key that could traverse cannot even be persisted.
 *
 *  - **The content type comes from the bytes.** A browser's `Content-Type` is a hint the
 *    uploader chooses; trusting it is how an HTML file ends up served as an image. The
 *    magic bytes are read, matched against a short allow-list, and anything unrecognised
 *    is refused whatever it claims to be.
 *
 *  - **Files live outside any web-servable path.** The API serves no static files at all,
 *    so this holds by construction rather than by configuration discipline. Evidence is
 *    only ever returned by an authenticated endpoint that re-checks who is asking, which
 *    is also why `PaymentEvidenceSummary` carries no URL: there is no link to forward.
 *
 *  - **Scanning state is recorded, not assumed.** `SKIPPED` is written honestly when no
 *    scanner is configured, so a reviewer opening a slip can tell an unscanned file from
 *    a clean one. A scanner is an external dependency the school has to provide; the port
 *    is here and the state is real (see docs/SECURITY.md).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { ErrorCode } from '@sfs/shared';

import { config } from '../config/env.js';
import { AppError, InternalError, PayloadTooLargeError } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('file-storage');

/**
 * What a proof-of-payment file may be.
 *
 * A photo or a one-page PDF, which is what a bank slip or a transfer confirmation
 * actually is. Kept short on purpose: every additional type is another parser a reviewer's
 * browser is asked to open, and an allow-list is the only kind of list that fails safe.
 *
 * `extension` is what the stored key ends in. It is chosen here rather than taken from
 * the upload, so the name on disk always matches the bytes in the file.
 */
interface AllowedType {
  readonly contentType: string;
  readonly extension: string;
  /** Leading bytes that identify the format. */
  readonly magic: readonly number[];
  /** Offset the magic bytes start at. Non-zero for container formats. */
  readonly offset?: number;
}

const ALLOWED_TYPES: readonly AllowedType[] = [
  { contentType: 'image/jpeg', extension: 'jpg', magic: [0xff, 0xd8, 0xff] },
  {
    contentType: 'image/png',
    extension: 'png',
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { contentType: 'application/pdf', extension: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  // WEBP is RIFF....WEBP: the format marker sits at byte 8, after the container header.
  { contentType: 'image/webp', extension: 'webp', magic: [0x57, 0x45, 0x42, 0x50], offset: 8 },
];

/** The types a client may usefully be told about, for an upload form. */
export const ACCEPTED_UPLOAD_CONTENT_TYPES: readonly string[] = ALLOWED_TYPES.map(
  (type) => type.contentType,
);

/** 400-family refusal for a file the system will not accept. */
export class UnsupportedFileError extends AppError {
  constructor(message: string) {
    super(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, message);
  }
}

function matches(bytes: Buffer, type: AllowedType): boolean {
  const offset = type.offset ?? 0;
  if (bytes.length < offset + type.magic.length) return false;
  return type.magic.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Identify a file from its own bytes.
 *
 * Returns null rather than throwing so the caller decides what an unrecognised file
 * means; for evidence, it means refusal.
 */
export function sniffContentType(bytes: Buffer): AllowedType | null {
  return ALLOWED_TYPES.find((type) => matches(bytes, type)) ?? null;
}

/** SHA-256 of the bytes, lower-case hex — the form the database constraint requires. */
export function checksumOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A stored file's key: two hex characters of fan-out, then the rest, then the extension.
 *
 * Random rather than content-addressed. Content addressing would be tidier, but the
 * `storage_key` column is globally unique, and the same bank slip legitimately supports
 * two payments — a parent who paid two children's fees with one transfer. Deduplicating
 * by content would make the second upload impossible; the `checksum` column is what tells
 * a reviewer the two are the same document.
 */
function newStorageKey(extension: string): string {
  const id = randomBytes(32).toString('hex');
  return `${id.slice(0, 2)}/${id.slice(2)}.${extension}`;
}

/** The same shape the database check constraint enforces. */
const STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{62}\.[a-z0-9]{2,5}$/;

/**
 * Resolve a key to an absolute path, refusing anything that escapes the root.
 *
 * Belt and braces: keys are generated here and validated by a regular expression and a
 * database constraint. This is the third check, and it is the one that would still hold
 * if a future code path started accepting a key from somewhere else.
 */
function pathFor(storageKey: string): string {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new InternalError('Refusing to use a storage key that is not in the expected form.');
  }

  const root = resolve(config.uploads.storagePath);
  const target = resolve(join(root, storageKey));

  if (target !== root && !target.startsWith(root + sep)) {
    throw new InternalError('Refusing to read or write outside the upload directory.');
  }

  return target;
}

export interface StoredFile {
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly checksum: string;
}

/**
 * Write an uploaded file and describe what was written.
 *
 * Refuses an empty file, one over the configured ceiling, and one whose bytes are not a
 * recognised image or PDF. The size check is here as well as on the multipart parser
 * because the parser's limit is a transport concern and this is the domain's.
 */
export async function storeUploadedFile(args: {
  readonly bytes: Buffer;
  readonly declaredContentType: string | null;
}): Promise<StoredFile> {
  if (args.bytes.length === 0) {
    throw new UnsupportedFileError('That file is empty.');
  }

  if (args.bytes.length > config.uploads.maxBytes) {
    const limitMb = Math.floor(config.uploads.maxBytes / (1024 * 1024));
    throw new PayloadTooLargeError(
      `That file is larger than the ${String(limitMb)} MB limit. A photo of a slip or a ` +
        'one-page PDF is what is expected.',
    );
  }

  const type = sniffContentType(args.bytes);
  if (type === null) {
    throw new UnsupportedFileError(
      'That file is not a JPEG, PNG, WEBP or PDF. Upload a photo of the slip or a PDF ' +
        'confirmation.',
    );
  }

  if (
    args.declaredContentType !== null &&
    args.declaredContentType !== type.contentType &&
    // A browser sending `application/octet-stream` for a file it could not identify is
    // ordinary. It is not a claim about the content, so it is not treated as one.
    args.declaredContentType !== 'application/octet-stream'
  ) {
    log.warn(
      { declaredContentType: args.declaredContentType, actualContentType: type.contentType },
      'An upload claimed one content type and contained another; the bytes decide',
    );
  }

  const storageKey = newStorageKey(type.extension);
  const target = pathFor(storageKey);

  await mkdir(dirname(target), { recursive: true });
  // `wx` fails rather than overwriting. With a random 32-byte key a collision is not
  // expected; silently overwriting somebody else's evidence if one happened is the part
  // that would be unforgivable.
  await writeFile(target, args.bytes, { flag: 'wx' });

  return {
    storageKey,
    contentType: type.contentType,
    byteSize: args.bytes.length,
    checksum: checksumOf(args.bytes),
  };
}

/**
 * Read a stored file back.
 *
 * A missing file is an operational fault, not a 404 for the caller to interpret: the
 * database row says it exists, so its absence means the storage volume was lost or
 * tampered with, and that should be loud.
 */
export async function readStoredFile(storageKey: string): Promise<Buffer> {
  try {
    return await readFile(pathFor(storageKey));
  } catch (error) {
    log.error({ err: error, storageKey }, 'A stored evidence file could not be read');
    throw new InternalError('That file could not be read from storage.', { cause: error });
  }
}

/**
 * Remove a file that must not be kept.
 *
 * Used for exactly one case: bytes a scanner reported as infected, which are deleted
 * before any row points at them. Evidence that has been recorded is never deleted —
 * superseding it sets a flag (Section 23).
 */
export async function discardStoredFile(storageKey: string): Promise<void> {
  try {
    await unlink(pathFor(storageKey));
  } catch (error) {
    // Logged and swallowed: the row was never created, so the file is inert. Failing the
    // request now would report an upload failure for a file that was correctly refused.
    log.warn({ err: error, storageKey }, 'Could not delete a rejected upload');
  }
}
