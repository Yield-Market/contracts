// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IWrappedCollateral
/// @notice Interface for Polymarket's WrappedCollateral token
interface IWrappedCollateral is IERC20 {
    /// @notice The underlying ERC20 token (e.g., USDC)
    function underlying() external view returns (address);

    /// @notice Wraps the specified amount of underlying into wrapped collateral
    /// @param _to The address to receive the wrapped tokens
    /// @param _amount The amount of underlying to wrap
    function wrap(address _to, uint256 _amount) external;

    /// @notice Unwraps the specified amount of tokens to the underlying
    /// @param _to The address to send the unwrapped tokens to
    /// @param _amount The amount of tokens to unwrap
    function unwrap(address _to, uint256 _amount) external;
}
