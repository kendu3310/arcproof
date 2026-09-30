/**
 * Spending limits, enforced in code.
 *
 * Nothing here consults a model. An agent may decide *what* to buy; it never
 * decides whether it is allowed to. Every check runs before a signature
 * exists, because once an EIP-3009 authorisation is signed the money is gone
 * and no later check can call it back.
 */

import { formatUnits } from "viem";

export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

export interface BudgetLimits {
  /** Largest single payment, in USDC atomic units (6 decimals). */
  maxPerCall: bigint;
  /** Total spend allowed across the lifetime of this budget. */
  maxTotal: bigint;
  /** Addresses this agent may pay. Anything else is refused. */
  allowedPayTo: string[];
  /** CAIP-2 networks this agent may pay on. */
  allowedNetworks: string[];
}

export interface PaymentTerms {
  amount: string;
  payTo: string;
  network: string;
  asset: string;
}

export class Budget {
  #spent = 0n;
  readonly limits: BudgetLimits;

  constructor(limits: BudgetLimits) {
    this.limits = limits;
  }

  get spent(): bigint {
    return this.#spent;
  }

  get remaining(): bigint {
    return this.limits.maxTotal - this.#spent;
  }

  /**
   * Throws unless the terms are within every limit.
   *
   * Call this before signing, never after. It deliberately refuses rather than
   * clamping: quietly paying less than asked would fail the request anyway,
   * and an agent that silently renegotiates is harder to reason about than one
   * that stops.
   */
  authorize(terms: PaymentTerms): bigint {
    const amount = parseAmount(terms.amount);

    if (!this.limits.allowedNetworks.includes(terms.network)) {
      throw new BudgetExceeded(
        `network ${terms.network} is not allowed (allowed: ${this.limits.allowedNetworks.join(", ")})`,
      );
    }

    const payTo = terms.payTo.toLowerCase();
    if (!this.limits.allowedPayTo.some((a) => a.toLowerCase() === payTo)) {
      throw new BudgetExceeded(`payee ${terms.payTo} is not on the allow-list`);
    }

    if (amount > this.limits.maxPerCall) {
      throw new BudgetExceeded(
        `price ${usd(amount)} exceeds the per-call limit of ${usd(this.limits.maxPerCall)}`,
      );
    }

    if (this.#spent + amount > this.limits.maxTotal) {
      throw new BudgetExceeded(
        `price ${usd(amount)} would take total spend to ${usd(this.#spent + amount)}, over the ${usd(this.limits.maxTotal)} cap`,
      );
    }

    return amount;
  }

  /** Record a payment that actually went through. */
  commit(amount: bigint): void {
    this.#spent += amount;
  }
}

/**
 * USDC amounts on Arc arrive as 6-decimal atomic units in x402 requirements.
 * Parsing them as a float first is how you end up authorising a different
 * number than the one you checked, so this stays in integers throughout.
 */
function parseAmount(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new BudgetExceeded(`unparseable amount ${JSON.stringify(raw)}`);
  }
  return BigInt(raw);
}

export function usd(atomic: bigint): string {
  return `$${formatUnits(atomic, 6)}`;
}
