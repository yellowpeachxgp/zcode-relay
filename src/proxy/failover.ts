import type { ProviderId } from "../provider/types.js";
import type { AccountFailureClass, AccountLease } from "../auth/pool-types.js";
import type { AuthManager } from "../auth/manager.js";

export interface AccountFailoverResult {
  response: Response;
  lease: AccountLease | null;
  attempts: number;
}

export async function executeWithAccountFailover(
  auth: AuthManager,
  provider: ProviderId,
  execute: (lease: AccountLease) => Promise<Response>,
  maxAttempts = 3,
  initialLease?: AccountLease,
): Promise<AccountFailoverResult> {
  let lease = initialLease ?? await auth.acquireCredential(provider);
  const pool = auth.getPool();
  const attemptLimit = Math.max(1, Math.floor(maxAttempts));

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    let response: Response;
    try {
      response = await execute(lease);
    } catch (error) {
      pool?.markFailure(lease.accountId, "network", (error as Error).message);
      lease.release();
      if (attempt >= attemptLimit) throw error;
      lease = await acquireNext(auth, provider, error);
      continue;
    }

    const failureClass = classifyUpstreamResponse(response);
    if (!failureClass) {
      return { response, lease, attempts: attempt };
    }

    pool?.markFailure(lease.accountId, failureClass, "upstream HTTP " + response.status);
    try {
      await response.body?.cancel();
    } catch {
      // 响应体已失败时，取消失败不应阻止账号切换。
    }
    lease.release();

    if (attempt >= attemptLimit) {
      return { response, lease: null, attempts: attempt };
    }
    lease = await acquireNext(auth, provider, response);
  }

  throw new Error("account failover exhausted");
}

export function classifyUpstreamResponse(response: Response): AccountFailureClass | null {
  if (response.status === 401) return "auth";
  if (response.status === 402) return "quota";
  if (response.status === 429) return "rate_limit";
  if (response.status >= 500) return "upstream";
  return null;
}

async function acquireNext(
  auth: AuthManager,
  provider: ProviderId,
  originalError: unknown,
): Promise<AccountLease> {
  try {
    return await auth.acquireCredential(provider);
  } catch {
    throw originalError;
  }
}
