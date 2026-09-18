import { vi } from 'vitest';

/**
 * Minimal `fetch` stub.
 *
 * Deliberately hand-rolled rather than depending on a global `Response`/`Headers`
 * implementation, so the same tests behave identically under jsdom and plain Node.
 */
export interface StubbedResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly requestId?: string;
}

function toFetchResponse(stub: StubbedResponse): unknown {
  const text = stub.rawBody ?? (stub.body === undefined ? '' : JSON.stringify(stub.body));
  const headers = new Map<string, string>([['content-type', 'application/json']]);
  if (stub.requestId !== undefined) headers.set('x-request-id', stub.requestId);

  return {
    ok: stub.status >= 200 && stub.status < 300,
    status: stub.status,
    headers: {
      get: (name: string): string | null => headers.get(name.toLowerCase()) ?? null,
    },
    text: (): Promise<string> => Promise.resolve(text),
  };
}

/** Install a fetch stub that resolves with the given response. */
export function stubFetchResponse(stub: StubbedResponse): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() => Promise.resolve(toFetchResponse(stub)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Install a fetch stub that rejects, simulating an unreachable server. */
export function stubFetchNetworkError(message = 'Failed to fetch'): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() => Promise.reject(new TypeError(message)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Install a fetch stub whose responses are returned in call order. */
export function stubFetchSequence(stubs: readonly StubbedResponse[]): ReturnType<typeof vi.fn> {
  let call = 0;
  const mock = vi.fn(() => {
    const stub = stubs[Math.min(call, stubs.length - 1)];
    call += 1;
    if (stub === undefined) throw new Error('stubFetchSequence called with no responses');
    return Promise.resolve(toFetchResponse(stub));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
