/**
 * The writer against a stand-in RPC that misbehaves the way Arc's public RPC
 * does under load: "Request exceeds defined limit" on a burst. A rate limit
 * before broadcast must be retried; nothing may ever be broadcast twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generatePrivateKey } from "viem/accounts";
import { ReceiptWriter, isRetryableBeforeSubmit } from "../src/receipt.ts";
import type { ArcNetwork } from "../src/networks.ts";

const REGISTRY = "0xac9e5859d9d85e7cd37dd852ed299edefbd6aece";
const HASH = `0x${"ab".repeat(32)}`;
const RATE_LIMITED = { code: -32005, message: "Request exceeds defined limit" };

interface Behaviour {
  /** How many eth_getTransactionCount calls to refuse before answering. */
  refuseNonce: number;
  /** How many eth_getTransactionReceipt calls to refuse before answering. */
  refuseReceipt: number;
}

async function fakeRpc(behaviour: Behaviour) {
  const calls: Record<string, number> = {};
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const requests = [].concat(JSON.parse(body));
      const answers = requests.map((r: { id: number; method: string }) => {
        calls[r.method] = (calls[r.method] ?? 0) + 1;
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
        const refuse = () => ({ jsonrpc: "2.0", id: r.id, error: RATE_LIMITED });
        switch (r.method) {
          case "eth_chainId": return ok("0x13b2");
          case "eth_getTransactionCount": return calls[r.method]! <= behaviour.refuseNonce ? refuse() : ok("0x7");
          case "eth_estimateGas": return ok("0xc350");
          case "eth_maxPriorityFeePerGas": return ok("0x3b9aca00");
          case "eth_gasPrice": return ok("0x4a817c800");
          case "eth_getBlockByNumber": return ok({ number: "0x10", baseFeePerGas: "0x4a817c800", timestamp: "0x1", transactions: [] });
          // A new block on every ask, as on a live chain: viem only re-polls
          // for the receipt when the head moves.
          case "eth_blockNumber": return ok(`0x${(0x11 + calls[r.method]!).toString(16)}`);
          case "eth_sendRawTransaction": return ok(HASH);
          case "eth_getTransactionByHash":
            return ok({
              hash: HASH, nonce: "0x7", from: "0x0000000000000000000000000000000000000001", to: REGISTRY,
              blockHash: null, blockNumber: null, transactionIndex: null, input: "0x", value: "0x0",
              gas: "0xc350", maxFeePerGas: "0x4a817c800", maxPriorityFeePerGas: "0x3b9aca00", type: "0x2",
              chainId: "0x13b2", v: "0x0", r: "0x1", s: "0x1", yParity: "0x0", accessList: [],
            });
          case "eth_getTransactionReceipt":
            return calls[r.method]! <= behaviour.refuseReceipt
              ? refuse()
              : ok({
                  transactionHash: HASH, status: "0x1", blockNumber: "0x11", blockHash: `0x${"cd".repeat(32)}`,
                  logs: [], gasUsed: "0xc1c7", cumulativeGasUsed: "0xc1c7", effectiveGasPrice: "0x4a817c800",
                  from: "0x0000000000000000000000000000000000000001", to: REGISTRY, transactionIndex: "0x0",
                  type: "0x2", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`,
                });
          default: return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
        }
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? answers : answers[0]));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const network: ArcNetwork = {
    key: "arc", name: "Fake Arc", chainId: 5042, caip2: "eip155:5042",
    rpcUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    explorerUrl: "https://explorer.invalid", usdc: "0x3600000000000000000000000000000000000000",
    usdcDecimals: 6, isTestnet: false,
  };
  return { network, calls, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

const receipt = () => ({
  requestId: `0x${"11".repeat(32)}` as const,
  payer: "0x0000000000000000000000000000000000000002" as const,
  inputHash: `0x${"22".repeat(32)}` as const,
  outputHash: `0x${"33".repeat(32)}` as const,
  bytesIn: 10n,
  bytesOut: 5n,
});

test("a rate limit before broadcast is retried, and the transaction is still sent exactly once", async () => {
  // viem retries a rate-limited call itself (three times, by default) before
  // giving up; six refusals get past that and reach the writer's own retry.
  const rpc = await fakeRpc({ refuseNonce: 6, refuseReceipt: 16 });
  try {
    const writer = new ReceiptWriter({ network: rpc.network, registry: REGISTRY, privateKey: generatePrivateKey() });
    assert.equal(await writer.record(receipt()), HASH);
    assert.equal(rpc.calls.eth_sendRawTransaction, 1);
    assert.ok(rpc.calls.eth_getTransactionCount! > 6);
  } finally {
    await rpc.close();
  }
});

test("a rate limit while waiting for the receipt waits again, and never resends", async () => {
  // Eight refusals: enough that viem gives up on its own and the error reaches
  // the writer, which waits again rather than resending. With four, viem
  // rides it out alone and this test would pass without the writer's retry.
  const rpc = await fakeRpc({ refuseNonce: 0, refuseReceipt: 8 });
  try {
    const writer = new ReceiptWriter({ network: rpc.network, registry: REGISTRY, privateKey: generatePrivateKey() });
    assert.equal(await writer.record(receipt()), HASH);
    assert.equal(rpc.calls.eth_sendRawTransaction, 1);
  } finally {
    await rpc.close();
  }
});

test("rate-limit messages count as retryable before broadcast; a revert does not", () => {
  assert.ok(isRetryableBeforeSubmit(new Error("Request exceeds defined limit. URL: https://rpc.mainnet.arc.io")));
  assert.ok(isRetryableBeforeSubmit(new Error("HTTP request failed. Status: 429")));
  assert.ok(isRetryableBeforeSubmit(new Error("Too Many Requests")));
  assert.equal(isRetryableBeforeSubmit(new Error("execution reverted: already recorded")), false);
});
