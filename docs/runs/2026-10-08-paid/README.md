# A paid call, published so you can check it

On 8 October 2026 a buyer agent paid **$0.02 in USDC** for one call to the
reference service, on **Arc mainnet**, and a receipt for it was written to the
registry. Everything needed to check that receipt independently is here or
already in this repository.

| | |
|---|---|
| Receipt transaction | [`0x88b3f321…5feb6cc6`](https://explorer.arc.io/tx/0x88b3f3210115fab48f6f71c809b1e454389faadbb6fcc242657d920c5feb6cc6) |
| Registry | `0xac9e5859d9d85e7cd37dd852ed299edefbd6aece` |
| Payer | `0x4746C70f17795adA8Bd2F17EE77bc67Aab796819` |
| Provider | `0x48A93E9e4D2B7bC7Cd585c5c2493770265410EaD` |
| Input | [`examples/glb-service/fixtures/sample.glb`](../../../examples/glb-service/fixtures/sample.glb), 2,066,880 bytes |
| Output | [`output.glb`](output.glb), 286,932 bytes |
| Payment nonce | `0x02e8cac3ee10f8374d167c2e75da440acccf62532e0d83625474905d6e7bbe14` |

[`transcript.txt`](transcript.txt) is the agent's own output from that run.

## Check it without trusting this project's code

Any keccak256 implementation and any Arc RPC will do. The point is that none
of it has to come from here.

1. **Fetch the receipt.** `eth_getTransactionReceipt` on the transaction above,
   against `https://rpc.mainnet.arc.io`. Take the log emitted by the registry
   address. `topics[1]` is the request id, `topics[3]` the payer; the data is
   five 32-byte words: input hash, output hash, bytes in, bytes out, timestamp.

2. **Hash the two files.** keccak256 of `sample.glb` must equal word 0, and of
   `output.glb` word 1. The byte counts must equal words 2 and 3.

3. **Check it was written for this payment.** Compute

   ```
   keccak256(abi.encodePacked(address payer, uint256 nonce, bytes32 inputHash))
   ```

   with the payer and nonce from the table and the input hash from step 2. It
   must equal `topics[1]`. The nonce is the one in the EIP-3009 authorization
   the buyer signed to pay; Gateway will not settle the same nonce twice, so
   no other payment can produce this id.

The browser on [aernyth.com](https://aernyth.com) does steps 1 and 2 for you:
pick this receipt and drop either file in.

## What this proves, and what it does not

It proves the provider publicly committed — in a transaction only its key could
sign, and which it cannot take back — to having returned exactly `output.glb`
for exactly `sample.glb`, to this payer, for this payment.

It does **not** prove `output.glb` is any good. A provider that returned a
broken file and recorded that broken file's hash would pass every step above.
What it would not escape is the record: anyone holding the file can show the
provider delivered it. Whether the file is good is checked separately, against
the content — here, by recounting the geometry, which the transcript shows held
at 9,216 triangles and 4,753 vertices on both sides.

## The settlement reference

The transcript shows `settlement 2ff9ae65-60e3-40a5-9337-6f718821b674`. That is
what Circle's Gateway returned as the payment's `transaction`. It is a UUID,
not an on-chain transaction hash — Gateway settles in batches, so no transfer
had happened when the service answered — and only Circle can look it up. That
is why the receipt is bound to the authorization nonce instead.
