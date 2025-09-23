// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./YMReceipt.sol";

/**
 * @title YMVaultFactory
 * @dev Deploys a single UpgradeableBeacon pointing to the YMVault implementation.
 *      Creates BeaconProxy instances for each new vault and initializes them.
 */
contract YMVaultFactory is Ownable {
    UpgradeableBeacon public immutable beacon;
    YMReceipt public immutable receipt;
    // optional: track tokenId binding to enforce uniqueness across vaults
    mapping(uint256 => address) public vaultForTokenId;

    event VaultProxyCreated(address indexed proxy, address indexed implementation);
    event ImplementationUpgraded(address indexed newImplementation);

    constructor(address implementation, address initialOwner, string memory baseURI) Ownable(initialOwner) {
        require(implementation != address(0), "impl required");
        UpgradeableBeacon b = new UpgradeableBeacon(implementation, initialOwner);
        beacon = b;
        YMReceipt r = new YMReceipt(baseURI, address(this));
        receipt = r;
    }

    function upgradeImplementation(address newImplementation) external onlyOwner {
        beacon.upgradeTo(newImplementation);
        emit ImplementationUpgraded(newImplementation);
    }

    function createVault(
        address _conditionalTokens,
        address _aavePool,
        address _collateralToken,
        address _aToken,
        bytes32 _conditionId,
        uint256 _yesPositionId,
        uint256 _noPositionId,
        address _initialOwner
    ) external returns (address proxy) {
        require(vaultForTokenId[_yesPositionId] == address(0), "YES id bound");
        require(vaultForTokenId[_noPositionId] == address(0), "NO id bound");

        // Validate Polymarket parameters using ConditionalTokens interface
        // yesId must match getPositionId(collateralToken, getCollectionId(0x0, conditionId, 1))
        // noId  must match getPositionId(collateralToken, getCollectionId(0x0, conditionId, 2))
        (bool okYesCol, bytes memory yesColData) = _conditionalTokens.staticcall(
            abi.encodeWithSignature("getCollectionId(bytes32,bytes32,uint256)", bytes32(0), _conditionId, 1)
        );
        require(okYesCol && yesColData.length >= 32, "CTF getCollectionId yes failed");
        bytes32 yesCol;
        assembly { yesCol := mload(add(yesColData, 32)) }

        (bool okNoCol, bytes memory noColData) = _conditionalTokens.staticcall(
            abi.encodeWithSignature("getCollectionId(bytes32,bytes32,uint256)", bytes32(0), _conditionId, 2)
        );
        require(okNoCol && noColData.length >= 32, "CTF getCollectionId no failed");
        bytes32 noCol;
        assembly { noCol := mload(add(noColData, 32)) }

        (bool okYesPid, bytes memory yesPidData) = _conditionalTokens.staticcall(
            abi.encodeWithSignature("getPositionId(address,bytes32)", _collateralToken, yesCol)
        );
        require(okYesPid && yesPidData.length >= 32, "CTF getPositionId yes failed");
        uint256 expectYes;
        assembly { expectYes := mload(add(yesPidData, 32)) }
        require(expectYes == _yesPositionId, "YES id mismatch");

        (bool okNoPid, bytes memory noPidData) = _conditionalTokens.staticcall(
            abi.encodeWithSignature("getPositionId(address,bytes32)", _collateralToken, noCol)
        );
        require(okNoPid && noPidData.length >= 32, "CTF getPositionId no failed");
        uint256 expectNo;
        assembly { expectNo := mload(add(noPidData, 32)) }
        require(expectNo == _noPositionId, "NO id mismatch");
        proxy = address(new BeaconProxy(address(beacon), ""));

        // Initialize via interface call
        (bool ok, ) = proxy.call(
            abi.encodeWithSignature(
                "initialize(address,address,address,address,bytes32,uint256,uint256,address,address)",
                _conditionalTokens,
                _aavePool,
                _collateralToken,
                _aToken,
                _conditionId,
                _yesPositionId,
                _noPositionId,
                address(receipt),
                _initialOwner
            )
        );
        require(ok, "init failed");
        // Bind tokenIds to vault and set minters on receipt (owner must be factory)
        vaultForTokenId[_yesPositionId] = proxy;
        vaultForTokenId[_noPositionId] = proxy;
        receipt.setMinters(_toArray(_yesPositionId, _noPositionId), _toArrayAddr(proxy, proxy));
        emit VaultProxyCreated(proxy, beacon.implementation());
    }

    function _toArray(uint256 a, uint256 b) private pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a; arr[1] = b;
    }
    function _toArrayAddr(address a, address b) private pure returns (address[] memory arr) {
        arr = new address[](2);
        arr[0] = a; arr[1] = b;
    }
}


