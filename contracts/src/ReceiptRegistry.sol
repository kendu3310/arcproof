// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title ReceiptRegistry
/// @notice Records a tamper-evident link between a payment and the bytes that
///         were actually delivered for it.
///
/// Circle's x402 batching SDK already settles the payment. What it does not do
/// — there is no `receipt`, `attest`, `proof` or `deliverable` anywhere in its
/// public API — is let the buyer prove afterwards that the thing it received is
/// the thing it paid for. An autonomous agent cannot eyeball a 3D model to see
/// whether a service quietly degraded it. This contract is the missing half:
/// the provider commits, on-chain, to the digests of the exact bytes in and
/// out, and the buyer recomputes those digests locally and compares.
///
/// Deliberately minimal. No owner, no upgrade path, no fees, no pausing. Anyone
/// may record; `provider` is `msg.sender`, so every receipt is attributable to
/// whoever wrote it, and a receipt from an address you did not pay is worth
/// exactly nothing to you. Trust comes from matching the provider you paid, not
/// from this contract gatekeeping who may write.
contract ReceiptRegistry {
    /// @param requestId  Derived off-chain as keccak256(payer ‖ nonce ‖ inputHash).
    ///                   Arc's PREVRANDAO is always 0, so ids are never drawn on-chain.
    /// @param provider   The service that performed the work (`msg.sender`).
    /// @param payer      The account that paid for it.
    /// @param inputHash  keccak256 of the request body the provider received.
    /// @param outputHash keccak256 of the response body the provider returned.
    /// @param bytesIn    Size of the input, for before/after reporting.
    /// @param bytesOut   Size of the output.
    /// @param timestamp  Block timestamp at the time of recording.
    event Receipt(
        bytes32 indexed requestId,
        address indexed provider,
        address indexed payer,
        bytes32 inputHash,
        bytes32 outputHash,
        uint64 bytesIn,
        uint64 bytesOut,
        uint64 timestamp
    );

    /// @notice A receipt already exists for this request id.
    /// @dev Replay protection: a provider must not be able to overwrite a
    ///      receipt after the fact with a different output digest.
    error ReceiptAlreadyRecorded(bytes32 requestId);

    /// @notice Neither digest may be zero.
    /// @dev An all-zero digest is the signature of an uninitialised variable,
    ///      not of an empty file, and it would silently pass a naive check.
    error EmptyDigest();

    /// @notice requestId => whether a receipt has been recorded.
    mapping(bytes32 => bool) public recorded;

    /// @notice Record a receipt for one served request.
    /// @dev Costs one cold SSTORE plus the log. At Arc's fee target
    ///      (~$0.001 per ERC-20 transfer) this stays well under a cent, which
    ///      is what makes per-call proof affordable at sub-cent prices.
    function record(
        bytes32 requestId,
        address payer,
        bytes32 inputHash,
        bytes32 outputHash,
        uint64 bytesIn,
        uint64 bytesOut
    ) external {
        if (inputHash == bytes32(0) || outputHash == bytes32(0)) {
            revert EmptyDigest();
        }
        if (recorded[requestId]) {
            revert ReceiptAlreadyRecorded(requestId);
        }

        recorded[requestId] = true;

        emit Receipt(
            requestId,
            msg.sender,
            payer,
            inputHash,
            outputHash,
            bytesIn,
            bytesOut,
            uint64(block.timestamp)
        );
    }
}
