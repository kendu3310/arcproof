/**
 * Guards for the free demo endpoint.
 *
 * The paid endpoint protects itself: calling it costs the caller more than it
 * costs us. The demo has no such defence — it is deliberately free so a
 * visitor can see the thing work without owning USDC on Arc — so the limits
 * have to be explicit.
 *
 * Every demo call still writes a real receipt to Arc mainnet, paid for with
 * the provider's own gas. That is the point: a demo that skipped the on-chain
 * write would demonstrate nothing. It also means an unbounded demo drains a
 * real wallet, which is why the balance floor below is not optional.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { PublicClient, Address } from "viem";
import { formatUnits } from "viem";

export interface DemoGuardOptions {
  client: PublicClient;
  /** The wallet that pays for demo receipts. */
  address: Address;
  /** Per-visitor daily allowance. */
  perIpPerDay: number;
  /** Total daily allowance across all visitors. */
  globalPerDay: number;
  /**
   * Stop serving the demo once the wallet falls below this, in 18-decimal
   * native units. Leaves enough behind that paying customers still get their
   * receipts written after the demo budget is gone.
   */
  minBalanceWei: bigint;
}

export interface DemoStatus {
  available: boolean;
  reason?: string;
  usedToday: number;
  globalPerDay: number;
  balance: string;
}

export function createDemoGuard(options: DemoGuardOptions) {
  const counts = new Map<string, number>();
  let globalCount = 0;
  let day = today();

  // Balance is read at most once a minute. Checking per request would add an
  // RPC round trip to every upload for a number that moves in fractions of a
  // cent.
  let balance = 0n;
  let balanceCheckedAt = 0;

  async function currentBalance(): Promise<bigint> {
    if (Date.now() - balanceCheckedAt > 60_000) {
      balance = await options.client.getBalance({ address: options.address });
      balanceCheckedAt = Date.now();
    }
    return balance;
  }

  function rollOver(): void {
    if (today() !== day) {
      day = today();
      counts.clear();
      globalCount = 0;
    }
  }

  async function status(ip?: string): Promise<DemoStatus> {
    rollOver();
    const funds = await currentBalance();
    const base = {
      usedToday: globalCount,
      globalPerDay: options.globalPerDay,
      balance: formatUnits(funds, 18),
    };

    if (funds < options.minBalanceWei) {
      return {
        ...base,
        available: false,
        reason:
          "The demo wallet is out of gas. Receipts are written on Arc mainnet and the provider pays for them, so the free demo stops before it would starve paying requests.",
      };
    }
    if (globalCount >= options.globalPerDay) {
      return {
        ...base,
        available: false,
        reason: `The demo has served its ${options.globalPerDay} runs for today. It resets at midnight UTC.`,
      };
    }
    if (ip && (counts.get(ip) ?? 0) >= options.perIpPerDay) {
      return {
        ...base,
        available: false,
        reason: `You have used all ${options.perIpPerDay} of today's free runs. Clone the repo to run it without limits.`,
      };
    }
    return { ...base, available: true };
  }

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const ip = clientIp(req);
      const state = await status(ip);

      if (!state.available) {
        // 503 rather than 429 when it is funding rather than rate limiting:
        // one is "come back later", the other is "this is over until someone
        // tops up a wallet", and a caller should be able to tell them apart.
        const outOfFunds = state.reason?.startsWith("The demo wallet");
        res.status(outOfFunds ? 503 : 429).json({ error: state.reason });
        return;
      }

      counts.set(ip, (counts.get(ip) ?? 0) + 1);
      globalCount += 1;
      next();
    })().catch(next);
  };

  return { middleware, status };
}

/**
 * Behind Render's proxy the socket address is the proxy, so the real visitor
 * is in x-forwarded-for. Only the first entry is meaningful; the rest can be
 * spoofed by the client.
 */
function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "unknown").trim();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
