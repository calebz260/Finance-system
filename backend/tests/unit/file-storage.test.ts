/**
 * Proof-of-payment storage.
 *
 * The cases here are the ones that decide whether an upload endpoint is a way into the
 * server: what the file is judged to be, what it is called on disk, and what happens to a
 * file that is too big or is not a document at all.
 *
 * Real files are written, to the configured test upload directory, because "the bytes came
 * back byte-for-byte" is most of what this module promises.
 */
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { config } from '../../src/config/env.js';
import { PayloadTooLargeError } from '../../src/lib/errors.js';
import {
  ACCEPTED_UPLOAD_CONTENT_TYPES,
  checksumOf,
  readStoredFile,
  sniffContentType,
  storeUploadedFile,
  UnsupportedFileError,
} from '../../src/lib/file-storage.js';

/** A minimal file of each accepted kind: the magic bytes, then some payload. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg body')]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png body'),
]);
const PDF = Buffer.from('%PDF-1.7\nbank slip\n');
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x20, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('webp body'),
]);

const written: string[] = [];

async function store(bytes: Buffer, declared: string | null = null): Promise<string> {
  const stored = await storeUploadedFile({ bytes, declaredContentType: declared });
  written.push(stored.storageKey);
  return stored.storageKey;
}

afterAll(async () => {
  // The suite's own files, and only those.
  for (const key of written) {
    await rm(resolve(config.uploads.storagePath, key), { force: true });
  }
});

describe('identifying an upload', () => {
  it('reads the format from the bytes, for each accepted kind', () => {
    expect(sniffContentType(JPEG)?.contentType).toBe('image/jpeg');
    expect(sniffContentType(PNG)?.contentType).toBe('image/png');
    expect(sniffContentType(PDF)?.contentType).toBe('application/pdf');
    expect(sniffContentType(WEBP)?.contentType).toBe('image/webp');
  });

  it('does not recognise anything else, however it is labelled', () => {
    expect(sniffContentType(Buffer.from('<html><body>not a slip</body></html>'))).toBeNull();
    expect(sniffContentType(Buffer.from('#!/bin/sh\nrm -rf /\n'))).toBeNull();
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
    // The right magic bytes at the wrong offset are not the format.
    expect(sniffContentType(Buffer.from('xx%PDF-1.7'))).toBeNull();
  });

  it('publishes the accepted types so a client can say what it will take', () => {
    expect(ACCEPTED_UPLOAD_CONTENT_TYPES).toContain('application/pdf');
    expect(ACCEPTED_UPLOAD_CONTENT_TYPES).toContain('image/jpeg');
  });
});

describe('storing an upload', () => {
  it('keys the file by a fan-out directory and a hex name, never by the uploaded name', async () => {
    const key = await store(PDF);

    // The same shape the database check constraint enforces: two hex characters, a
    // slash, sixty-two more, an extension. Nothing here can traverse a directory.
    expect(key).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{62}\.pdf$/);
  });

  it('gives two uploads of identical bytes two distinct keys', async () => {
    // Content addressing would collapse them, and `storage_key` is globally unique — so
    // the same bank slip supporting two children's payments would become impossible.
    const first = await store(PDF);
    const second = await store(PDF);

    expect(first).not.toBe(second);
  });

  it('records the checksum of the bytes, which is what identifies a duplicate document', async () => {
    const stored = await storeUploadedFile({ bytes: JPEG, declaredContentType: 'image/jpeg' });
    written.push(stored.storageKey);

    expect(stored.checksum).toBe(checksumOf(JPEG));
    expect(stored.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.byteSize).toBe(JPEG.byteLength);
    expect(stored.contentType).toBe('image/jpeg');
  });

  it('writes the exact bytes and reads them back unchanged', async () => {
    const key = await store(PNG);

    expect(await readStoredFile(key)).toEqual(PNG);
    // And on disk, where a reviewer's browser will eventually be sent them from.
    expect(await readFile(resolve(config.uploads.storagePath, key))).toEqual(PNG);
  });

  it('believes the bytes over the browser, and stores the file as what it actually is', async () => {
    // A PDF announced as a PNG. The extension and content type follow the content.
    const stored = await storeUploadedFile({ bytes: PDF, declaredContentType: 'image/png' });
    written.push(stored.storageKey);

    expect(stored.contentType).toBe('application/pdf');
    expect(stored.storageKey.endsWith('.pdf')).toBe(true);
  });

  it('refuses a file that is not a document at all', async () => {
    await expect(
      storeUploadedFile({
        bytes: Buffer.from('<script>alert(1)</script>'),
        declaredContentType: 'image/png',
      }),
    ).rejects.toThrow(UnsupportedFileError);
  });

  it('refuses an empty file', async () => {
    await expect(
      storeUploadedFile({ bytes: Buffer.alloc(0), declaredContentType: 'application/pdf' }),
    ).rejects.toThrow(UnsupportedFileError);
  });

  it('refuses a file over the configured ceiling, and says what the ceiling is', async () => {
    const oversized = Buffer.concat([PDF, Buffer.alloc(config.uploads.maxBytes + 1)]);

    await expect(
      storeUploadedFile({ bytes: oversized, declaredContentType: 'application/pdf' }),
    ).rejects.toThrow(PayloadTooLargeError);
  });
});
