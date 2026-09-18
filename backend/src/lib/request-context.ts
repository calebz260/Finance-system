/**
 * Ambient per-request context.
 *
 * Backed by AsyncLocalStorage so deep service and repository code can reach the request
 * id -- and, from Phase 2 onwards, the acting user and their school -- without threading
 * a context object through every function signature. This is what lets audit-log writes
 * (Section 27) always record who performed an action.
 *
 * Reads are deliberately tolerant: outside a request (a CLI script, a seed, a background
 * job) the store is simply absent.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  readonly requestId: string;
  /** Populated by the authentication middleware in Phase 2. */
  actorUserId?: string;
  /** Tenant scope for every query (Section 5). */
  schoolId?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly startedAt: Date;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Attach the authenticated actor to the live context. No-op outside a request. */
export function setContextActor(actor: { userId: string; schoolId?: string }): void {
  const context = storage.getStore();
  if (context === undefined) return;
  context.actorUserId = actor.userId;
  if (actor.schoolId !== undefined) context.schoolId = actor.schoolId;
}
