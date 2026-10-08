// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title BatchRegistry
/// @notice Anchors many delivery receipts in one transaction.
///
/// ReceiptRegistry spends a transaction on every receipt: 49,559 gas, about
/// $0.001, which is more than the whole price of the sub-cent calls
/// nanopayments are for. This contract is the proposal in
/// design/batched-receipts.md, and it is not yet used by anything.
///
/// The provider signs each receipt with EIP-712 and returns the signature with
/// the bytes, which on its own already stops it denying the delivery. What the
/// chain adds is time and publicity, and those batch: the provider commits one
/// Merkle root over many receipts. The leaf of each receipt is its EIP-712
/// struct hash, hashed again, so one value serves both the signature and the
/// tree, and a leaf can never be mistaken for an inner node.
///
/// Like ReceiptRegistry it keeps no storage, has no owner and gates nothing.
/// Duplicate request ids are not refused here — that guard cost 22,100 gas a
/// receipt. A provider that signs two different receipts for one paid request
/// has instead produced public, attributable proof that it equivocated.
contract BatchRegistry {
    struct Receipt {
        bytes32 requestId;
        address payer;
        bytes32 inputHash;
        bytes32 outputHash;
        uint64 bytesIn;
        uint64 bytesOut;
    }

    bytes32 public constant RECEIPT_TYPEHASH = keccak256(
        "Receipt(bytes32 requestId,address payer,bytes32 inputHash,bytes32 outputHash,uint64 bytesIn,uint64 bytesOut)"
    );

    /// Binds every signature to this chain and this contract, so a receipt
    /// signed on testnet cannot be replayed as a mainnet one.
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// One provider's commitment to a batch of signed receipts.
    event Batch(bytes32 indexed root, address indexed provider, uint32 count, uint64 timestamp);

    /// A single receipt put on record by anyone holding the provider's
    /// signature over it — usually the buyer, when the provider never
    /// committed the batch it belonged to.
    event Anchored(
        bytes32 indexed requestId,
        address indexed provider,
        address indexed payer,
        bytes32 inputHash,
        bytes32 outputHash,
        uint64 bytesIn,
        uint64 bytesOut,
        uint64 timestamp
    );

    error EmptyBatch();
    error BadSignature();

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Aernyth"),
                keccak256("2"),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Commit a Merkle root over `count` signed receipts. The caller is
    ///         the provider: only its key can make this commitment.
    function commit(bytes32 root, uint32 count) external {
        if (root == bytes32(0) || count == 0) revert EmptyBatch();
        emit Batch(root, msg.sender, count, uint64(block.timestamp));
    }

    /// @notice Put one receipt on record using the provider's signature.
    /// @dev    Whoever calls pays the gas. Nothing here trusts the caller; the
    ///         signature has to recover to `provider` or the call reverts.
    function anchor(Receipt calldata receipt, address provider, bytes calldata signature) external {
        address signer = _recover(digestOf(receipt), signature);
        if (signer == address(0) || signer != provider) revert BadSignature();
        emit Anchored(
            receipt.requestId,
            provider,
            receipt.payer,
            receipt.inputHash,
            receipt.outputHash,
            receipt.bytesIn,
            receipt.bytesOut,
            uint64(block.timestamp)
        );
    }

    /// @notice The EIP-712 struct hash of a receipt.
    function structHash(Receipt calldata receipt) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RECEIPT_TYPEHASH,
                receipt.requestId,
                receipt.payer,
                receipt.inputHash,
                receipt.outputHash,
                receipt.bytesIn,
                receipt.bytesOut
            )
        );
    }

    /// @notice The digest a provider signs.
    function digestOf(Receipt calldata receipt) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash(receipt)));
    }

    /// @notice The Merkle leaf for a receipt: its struct hash, hashed again.
    function leafOf(Receipt calldata receipt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(structHash(receipt)));
    }

    /// @dev ecrecover, refusing malleable signatures: for every valid (r, s)
    ///      the pair (r, n - s) also recovers, and accepting both would give one
    ///      receipt two distinct signatures.
    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
