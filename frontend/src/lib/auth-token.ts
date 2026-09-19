/**
 * Where the access token lives, and how a stale one is renewed.
 *
 * In memory, deliberately. Not `localStorage`, not `sessionStorage`: anything readable
 * by JavaScript is readable by an XSS payload, and a token sitting in web storage
 * survives the tab that earned it. The cost is that a page reload starts with no token
 * — which is fine, because the httpOnly refresh cookie can mint a new one, and that
 * cookie is the credential deliberately kept out of JavaScript's reach.
 *
 * This module is a plain store rather than React state because `api-client` must be
 * able to read the token and trigger a renewal without importing React or reaching into
 * a component tree. The provider registers the renewal callback at mount; everything
 * else just reads.
 */
type RefreshHandler = () => Promise<string | null>;

let accessToken: string | null = null;
let refreshHandler: RefreshHandler | null = null;
/** The renewal in flight, so concurrent 401s produce one refresh rather than several. */
let inFlightRefresh: Promise<string | null> | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function clearAccessToken(): void {
  accessToken = null;
}

/** Registered by the auth provider; unregistered when it unmounts. */
export function setRefreshHandler(handler: RefreshHandler | null): void {
  refreshHandler = handler;
}

/**
 * Renew the access token, collapsing concurrent callers onto one request.
 *
 * Without the de-duplication, a screen that loads four resources at once would fire
 * four refreshes on expiry. Three of them would present an already-consumed refresh
 * token, which the server treats as theft and answers by destroying the session — so
 * this is a correctness requirement, not an optimisation.
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (refreshHandler === null) return null;
  inFlightRefresh ??= refreshHandler().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}
