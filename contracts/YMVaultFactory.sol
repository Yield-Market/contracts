// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title YMVaultFactory
 * @dev Deploys a single UpgradeableBeacon pointing to the YMVault implementation.
 *      Creates BeaconProxy instances for each new vault and initializes them.
 */
contract YMVaultFactory is Ownable {
    UpgradeableBeacon public immutable beacon;

    event VaultProxyCreated(address indexed proxy, address indexed implementation);
    event ImplementationUpgraded(address indexed newImplementation);

    constructor(address implementation, address initialOwner) Ownable(initialOwner) {
        require(implementation != address(0), "impl required");
        UpgradeableBeacon b = new UpgradeableBeacon(implementation, initialOwner);
        beacon = b;
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
        proxy = address(new BeaconProxy(address(beacon), ""));

        // Initialize via interface call
        (bool ok, ) = proxy.call(
            abi.encodeWithSignature(
                "initialize(address,address,address,address,bytes32,uint256,uint256,address)",
                _conditionalTokens,
                _aavePool,
                _collateralToken,
                _aToken,
                _conditionId,
                _yesPositionId,
                _noPositionId,
                _initialOwner
            )
        );
        require(ok, "init failed");
        emit VaultProxyCreated(proxy, beacon.implementation());
    }
}


