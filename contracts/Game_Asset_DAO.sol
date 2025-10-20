pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract GameAssetDAOFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => mapping(uint256 => euint32)) public encryptedAssetVotes; // batchId => assetId => encryptedVoteCount
    mapping(uint256 => mapping(uint256 => euint32)) public encryptedTypeVotes;  // batchId => typeId => encryptedVoteCount

    uint256 public currentBatchId;
    uint256 public cooldownSeconds;
    bool public paused;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    struct Batch {
        bool isOpen;
        uint256 startTime;
        uint256 endTime;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId, uint256 startTime);
    event BatchClosed(uint256 indexed batchId, uint256 endTime);
    event VoteSubmitted(address indexed provider, uint256 indexed batchId, uint256 assetId, uint256 typeId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] assetVoteCounts, uint256[] typeVoteCounts);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error InvalidBatch();
    error BatchNotOpen();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default cooldown
        currentBatchId = 1;
        _openBatch(currentBatchId);
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() external onlyOwner {
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (!batches[batchId].isOpen) revert InvalidBatch();
        batches[batchId].isOpen = false;
        batches[batchId].endTime = block.timestamp;
        emit BatchClosed(batchId, block.timestamp);
    }

    function submitVote(
        uint256 batchId,
        uint256 assetId,
        uint256 typeId,
        euint32 encryptedVoteWeight
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batches[batchId].isOpen) revert BatchNotOpen();
        _initIfNeeded(encryptedAssetVotes[batchId][assetId]);
        _initIfNeeded(encryptedTypeVotes[batchId][typeId]);

        encryptedAssetVotes[batchId][assetId] = encryptedAssetVotes[batchId][assetId].add(encryptedVoteWeight);
        encryptedTypeVotes[batchId][typeId] = encryptedTypeVotes[batchId][typeId].add(encryptedVoteWeight);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit VoteSubmitted(msg.sender, batchId, assetId, typeId);
    }

    function requestBatchResultsDecryption(uint256 batchId)
        external
        onlyProvider
        whenNotPaused
        checkDecryptionCooldown
    {
        if (batches[batchId].isOpen) revert BatchNotOpen(); // Batch must be closed

        uint256[] memory assetIds = new uint256[](2); // Example: 2 assets
        uint256[] memory typeIds = new uint256[](3);  // Example: 3 types

        // Example asset IDs
        assetIds[0] = 1;
        assetIds[1] = 2;

        // Example type IDs
        typeIds[0] = 1;
        typeIds[1] = 2;
        typeIds[2] = 3;

        bytes32[] memory cts = new bytes32[](assetIds.length + typeIds.length);
        for (uint256 i = 0; i < assetIds.length; i++) {
            _initIfNeeded(encryptedAssetVotes[batchId][assetIds[i]]);
            cts[i] = encryptedAssetVotes[batchId][assetIds[i]].toBytes32();
        }
        for (uint256 i = 0; i < typeIds.length; i++) {
            _initIfNeeded(encryptedTypeVotes[batchId][typeIds[i]]);
            cts[assetIds.length + i] = encryptedTypeVotes[batchId][typeIds[i]].toBytes32();
        }

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        // Security: Replay protection prevents processing the same decryption result multiple times.

        DecryptionContext memory ctx = decryptionContexts[requestId];
        uint256 batchId = ctx.batchId;

        // Rebuild ciphertexts in the exact same order as during requestBatchResultsDecryption
        uint256[] memory assetIds = new uint256[](2); // Must match requestBatchResultsDecryption
        uint256[] memory typeIds = new uint256[](3);  // Must match requestBatchResultsDecryption

        assetIds[0] = 1;
        assetIds[1] = 2;
        typeIds[0] = 1;
        typeIds[1] = 2;
        typeIds[2] = 3;

        bytes32[] memory currentCts = new bytes32[](assetIds.length + typeIds.length);
        for (uint256 i = 0; i < assetIds.length; i++) {
            _initIfNeeded(encryptedAssetVotes[batchId][assetIds[i]]);
            currentCts[i] = encryptedAssetVotes[batchId][assetIds[i]].toBytes32();
        }
        for (uint256 i = 0; i < typeIds.length; i++) {
            _initIfNeeded(encryptedTypeVotes[batchId][typeIds[i]]);
            currentCts[assetIds.length + i] = encryptedTypeVotes[batchId][typeIds[i]].toBytes32();
        }

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        // Security: State hash verification ensures that the contract state (ciphertexts)
        // has not changed between the decryption request and the callback processing.
        // This prevents scenarios where an attacker might alter the data after a request
        // but before the decryption result is processed.
        if (currentStateHash != ctx.stateHash) revert StateMismatch();

        // Security: Proof verification ensures the cleartexts are authentic and correctly decrypted
        // by the FHE decryption service, preventing malicious or incorrect decryptions.
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        uint256 numAssetVotes = assetIds.length;
        uint256 numTypeVotes = typeIds.length;

        uint256[] memory assetVoteCounts = new uint256[](numAssetVotes);
        uint256[] memory typeVoteCounts = new uint256[](numTypeVotes);

        uint256 offset = 0;
        for (uint256 i = 0; i < numAssetVotes; i++) {
            assetVoteCounts[i] = abi.decode(cleartexts.offset(offset), (uint32));
            offset += 32;
        }
        for (uint256 i = 0; i < numTypeVotes; i++) {
            typeVoteCounts[i] = abi.decode(cleartexts.offset(offset), (uint32));
            offset += 32;
        }

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, assetVoteCounts, typeVoteCounts);
    }

    function _openBatch(uint256 batchId) private {
        batches[batchId] = Batch({ isOpen: true, startTime: block.timestamp, endTime: 0 });
        emit BatchOpened(batchId, block.timestamp);
    }

    function _hashCiphertexts(bytes32[] memory cts) private pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 v) private view {
        if (!v.isInitialized()) {
            revert NotInitialized();
        }
    }

    function _requireInitialized(euint32 v) private view {
        if (!v.isInitialized()) {
            revert NotInitialized();
        }
    }
}