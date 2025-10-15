// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "./IWrappedCollateral.sol";

// Conditional Tokens interface
interface IConditionalTokens {
    function balanceOf(
        address owner,
        uint256 id
    ) external view returns (uint256);

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) external;

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external;

    function splitPosition(
        IERC20 collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external;

    function mergePositions(
        IERC20 collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external;

    function getPositionId(
        IERC20 collateralToken,
        bytes32 collectionId
    ) external pure returns (uint256);

    function getCollectionId(
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 indexSet
    ) external view returns (bytes32);

    function payoutNumerators(
        bytes32 conditionId,
        uint256 index
    ) external view returns (uint256);

    function payoutDenominator(
        bytes32 conditionId
    ) external view returns (uint256);

    function redeemPositions(
        IERC20 collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external;
}

// AAVE Pool interface
interface IAavePool {
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256);

    function getReserveNormalizedIncome(
        address asset
    ) external view returns (uint256);
}

// aToken interface
interface IAToken is IERC20 {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);

    /**
     * @dev Returns the current balance of the user. The value is the scaled balance multiplied by the current liquidity index.
     * @param user The user for which the balance is being queried
     * @return The current balance of the user in underlying asset units
     **/
    function balanceOf(address user) external view override returns (uint256);
}

interface IYMReceipt {
    function mint(address to, uint256 id, uint256 amount) external;

    function burn(address from, uint256 id, uint256 amount) external;

    function balanceOf(
        address account,
        uint256 id
    ) external view returns (uint256);
}

/**
 * @title YM Vault
 * @dev Yield-enhanced bridge vault for Polymarket conditional tokens
 *
 * Core capabilities:
 * 1. Accept Polymarket YES/NO tokens and account user balances as YES.Y/NO.Y
 * 2. Internally match YES/NO pairs and merge into USDC
 * 3. Supply USDC into AAVE to earn yield
 * 4. After market resolution, distribute principal + yield to the winning side
 */
contract YMVault is ReentrancyGuard, Ownable, IERC1155Receiver {
    constructor() Ownable(msg.sender) {}

    // ===== State variables =====

    // External contracts (set in initialize)
    IConditionalTokens public conditionalTokens;
    IAavePool public aavePool;
    IERC20 public collateralToken; // USDC or WrappedUSDC
    IAToken public aToken; // aUSDC
    IYMReceipt public receipt; // unified ERC1155 for YES.Y/NO.Y

    // Wrapped collateral support
    bool public isWrappedCollateral; // True if collateral is wrapped
    IERC20 public underlyingToken; // Underlying USDC if wrapped

    // Market parameters
    bytes32 public conditionId;
    uint256 public yesPositionId;
    uint256 public noPositionId;

    // Per-user token balance tracking
    mapping(address => uint256) public yesYTokens; // User's YES.Y token balance
    mapping(address => uint256) public noYTokens; // User's NO.Y token balance

    // Internal accounting
    uint256 public totalYesDeposits; // Total YES deposits
    uint256 public totalNoDeposits; // Total NO deposits
    uint256 public totalMatched; // Matched YES/NO amount
    uint256 public totalYielding; // Amount supplied to AAVE

    // Market state
    bool public isResolved; // Whether the market is resolved
    bool public yesWon; // Whether YES outcome won
    uint256 public finalPayoutRatio; // Final payout ratio

    // ===== Events =====

    event YesTokenDeposited(
        address indexed user,
        uint256 amount,
        uint256 yesYMinted
    );
    event NoTokenDeposited(
        address indexed user,
        uint256 amount,
        uint256 noYMinted
    );
    event YesTokenWithdrawn(address indexed user, uint256 amount);
    event NoTokenWithdrawn(address indexed user, uint256 amount);
    event PositionsMatched(uint256 amount, uint256 usdcGenerated);
    event YieldDeposited(uint256 amount, uint256 aTokensReceived);
    event MarketResolved(bool yesWon, uint256 payoutRatio);
    event Withdrawal(
        address indexed user,
        address indexed to,
        uint256 yesYBurned,
        uint256 noYBurned,
        uint256 usdcReceived
    );

    bool private _initialized;

    // ===== Initializer =====
    function initialize(
        address _conditionalTokens,
        address _aavePool,
        address _collateralToken,
        address _aToken,
        bytes32 _conditionId,
        uint256 _yesPositionId,
        uint256 _noPositionId,
        address _receipt,
        address _initialOwner
    ) external {
        require(!_initialized, "Already initialized");

        conditionalTokens = IConditionalTokens(_conditionalTokens);
        aavePool = IAavePool(_aavePool);
        collateralToken = IERC20(_collateralToken);
        aToken = IAToken(_aToken);
        receipt = IYMReceipt(_receipt);

        // Check if collateral token is wrapped
        try IWrappedCollateral(_collateralToken).underlying() returns (
            address underlying
        ) {
            // It's a wrapped collateral token
            isWrappedCollateral = true;
            underlyingToken = IERC20(underlying);
        } catch {
            // It's a regular token (USDC)
            isWrappedCollateral = false;
            underlyingToken = collateralToken;
        }

        conditionId = _conditionId;
        yesPositionId = _yesPositionId;
        noPositionId = _noPositionId;

        _transferOwnership(_initialOwner);
        _initialized = true;
    }

    // ===== Main functions =====
    /**
     * @dev Withdraw YES.Y to original YES token (before resolution)
     * @param amount YES.Y amount to withdraw
     */
    function withdrawYesTokens(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be greater than 0");
        require(!isResolved, "Market already resolved, use withdraw() instead");
        require(yesYTokens[msg.sender] >= amount, "Insufficient YES.Y balance");

        // Reduce user's YES.Y balance
        yesYTokens[msg.sender] = yesYTokens[msg.sender] - amount;
        totalYesDeposits = totalYesDeposits - amount;

        // Ensure the vault has enough YES tokens; if not, pull USDC from AAVE and split
        _ensurePositionLiquidityAndSplit(yesPositionId, amount);

        // Transfer YES back to user
        conditionalTokens.safeTransferFrom(
            address(this),
            msg.sender,
            yesPositionId,
            amount,
            ""
        );

        emit YesTokenWithdrawn(msg.sender, amount);
    }

    /**
     * @dev Withdraw NO.Y to original NO token (before resolution)
     * @param amount NO.Y amount to withdraw
     */
    function withdrawNoTokens(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be greater than 0");
        require(!isResolved, "Market already resolved, use withdraw() instead");
        require(noYTokens[msg.sender] >= amount, "Insufficient NO.Y balance");

        // Reduce user's NO.Y balance
        noYTokens[msg.sender] = noYTokens[msg.sender] - amount;
        totalNoDeposits = totalNoDeposits - amount;

        // Ensure the vault has enough NO tokens; if not, pull USDC from AAVE and split
        _ensurePositionLiquidityAndSplit(noPositionId, amount);

        // Transfer NO back to user
        conditionalTokens.safeTransferFrom(
            address(this),
            msg.sender,
            noPositionId,
            amount,
            ""
        );

        emit NoTokenWithdrawn(msg.sender, amount);
    }

    /**
     * @dev Withdraw funds (after market resolution)
     */
    function withdraw(address to) external nonReentrant {
        if (!isResolved) {
            resolveMarket();
        }

        uint256 yesYBalance = yesYTokens[msg.sender];
        uint256 noYBalance = noYTokens[msg.sender];

        require(yesYBalance > 0 || noYBalance > 0, "No tokens to withdraw");

        uint256 usdcToWithdraw = 0;
        uint256 usdcReceived = 0;

        // Compute user's USDC entitlement
        if (yesWon) {
            // YES won: only YES.Y holders receive USDC
            if (yesYBalance > 0) {
                usdcToWithdraw = _calculatePayout(yesYBalance, true);
            }
            // NO.Y becomes worthless; no payout
        } else {
            // NO won: only NO.Y holders receive USDC
            if (noYBalance > 0) {
                usdcToWithdraw = _calculatePayout(noYBalance, false);
            }
            // YES.Y becomes worthless; no payout
        }

        // Withdraw USDC if any
        if (usdcToWithdraw > 0) {
            // Cap by current aToken balance (available underlying)
            uint256 availableUnderlying = aToken.balanceOf(address(this));
            if (usdcToWithdraw > availableUnderlying) {
                usdcToWithdraw = availableUnderlying;
            }
            
            // Withdraw from AAVE: use appropriate asset based on collateral type
            if (isWrappedCollateral) {
                // For wrapped collateral: withdraw underlying USDC from AAVE directly to user
                // Note: This gives user underlying USDC instead of wrapped version
                usdcReceived = aavePool.withdraw(
                    address(underlyingToken), // underlying USDC address
                    usdcToWithdraw,
                    to // send underlying USDC directly to user
                );
            } else {
                // For regular USDC: withdraw directly to user
                usdcReceived = aavePool.withdraw(
                    address(collateralToken), // USDC address
                    usdcToWithdraw,
                    to
                );
            }

            // Check withdraw result
            require(usdcReceived > 0, "AAVE withdraw failed");
        }

        // Zero out user's balances after successful withdraw
        if (yesYBalance > 0) {
            totalYesDeposits -= yesYTokens[msg.sender];
            yesYTokens[msg.sender] = 0;
            // Burn YES.Y receipts
            receipt.burn(msg.sender, yesPositionId, yesYBalance);
        }
        if (noYBalance > 0) {
            totalNoDeposits -= noYTokens[msg.sender];
            noYTokens[msg.sender] = 0;
            // Burn NO.Y receipts
            receipt.burn(msg.sender, noPositionId, noYBalance);
        }

        emit Withdrawal(msg.sender, to, yesYBalance, noYBalance, usdcReceived);
    }

    /**
     * @dev Resolve market using payout data from ConditionalTokens
     */
    function resolveMarket() internal {
        require(!isResolved, "Market already resolved");

        // Read payout data from ConditionalTokens
        uint256 yesPayoutNumerator = conditionalTokens.payoutNumerators(
            conditionId,
            0
        );
        uint256 noPayoutNumerator = conditionalTokens.payoutNumerators(
            conditionId,
            1
        );
        uint256 payoutDenominator = conditionalTokens.payoutDenominator(
            conditionId
        );

        require(payoutDenominator > 0, "Market not resolved on Polymarket");

        // Determine winner
        yesWon = yesPayoutNumerator > noPayoutNumerator;
        finalPayoutRatio = yesWon ? yesPayoutNumerator : noPayoutNumerator;

        // Finalize by redeeming remaining winning tokens into USDC and supply to AAVE
        _finalizeYield();

        isResolved = true;
        emit MarketResolved(yesWon, finalPayoutRatio);
    }

    // ===== Internal functions =====

    /**
     * @dev Try to match YES/NO and invest into AAVE
     */
    function _tryMatchAndInvest() internal {
        uint256 currentYes = totalYesDeposits - totalMatched;
        uint256 currentNo = totalNoDeposits - totalMatched;

        if (currentYes > 0 && currentNo > 0) {
            uint256 matchAmount = currentYes < currentNo
                ? currentYes
                : currentNo;

            // Merge matched YES/NO into USDC
            uint256[] memory partition = new uint256[](2);
            partition[0] = 1; // YES
            partition[1] = 2; // NO

            conditionalTokens.mergePositions(
                collateralToken,
                bytes32(0), // parentCollectionId
                conditionId,
                partition,
                matchAmount
            );

            totalMatched = totalMatched + matchAmount;

            // Handle wrapped/unwrapped collateral and supply to AAVE
            uint256 usdcBalance = collateralToken.balanceOf(address(this));
            if (usdcBalance > 0) {
                uint256 usdcToSupply;

                if (isWrappedCollateral) {
                    // Unwrap the wrapped collateral to get underlying USDC
                    IWrappedCollateral(address(collateralToken)).unwrap(
                        address(this),
                        usdcBalance
                    );
                    usdcToSupply = underlyingToken.balanceOf(address(this));

                    // Approve and supply underlying USDC to AAVE
                    underlyingToken.approve(address(aavePool), usdcToSupply);
                    aavePool.supply(
                        address(underlyingToken),
                        usdcToSupply,
                        address(this),
                        0
                    );
                } else {
                    // Supply collateral token directly (it's already USDC)
                    usdcToSupply = usdcBalance;
                    collateralToken.approve(address(aavePool), usdcToSupply);
                    aavePool.supply(
                        address(collateralToken),
                        usdcToSupply,
                        address(this),
                        0
                    );
                }

                totalYielding = totalYielding + usdcToSupply;

                emit PositionsMatched(matchAmount, usdcToSupply);
                emit YieldDeposited(
                    usdcToSupply,
                    aToken.balanceOf(address(this))
                );
            }
        }
    }

    /**
     * @dev Ensure the vault holds at least `requiredAmount` of `positionId` tokens.
     * If insufficient, withdraw USDC from AAVE and split via ConditionalTokens to mint YES/NO.
     */
    function _ensurePositionLiquidityAndSplit(
        uint256 positionId,
        uint256 requiredAmount
    ) internal {
        uint256 currentBalance = conditionalTokens.balanceOf(
            address(this),
            positionId
        );

        if (currentBalance >= requiredAmount) {
            return;
        }

        uint256 deficit = requiredAmount - currentBalance;

        // Withdraw required collateral from AAVE
        uint256 availableUnderlying = aToken.balanceOf(address(this));
        require(
            availableUnderlying >= deficit,
            "Insufficient AAVE liquidity"
        );

        if (isWrappedCollateral) {
            // Withdraw underlying USDC
            uint256 withdrawn = aavePool.withdraw(
                address(underlyingToken),
                deficit,
                address(this)
            );
            require(withdrawn >= deficit, "AAVE withdraw shortfall");

            // Approve wrapped collateral to pull underlying, then wrap to this vault
            underlyingToken.approve(address(collateralToken), deficit);
            IWrappedCollateral(address(collateralToken)).wrap(
                address(this),
                deficit
            );
        } else {
            // Withdraw USDC directly
            uint256 withdrawn = aavePool.withdraw(
                address(collateralToken),
                deficit,
                address(this)
            );
            require(withdrawn >= deficit, "AAVE withdraw shortfall");
        }

        // Approve ConditionalTokens to spend collateral and split to mint YES/NO
        collateralToken.approve(address(conditionalTokens), deficit);

        uint256[] memory partition = new uint256[](2);
        partition[0] = 1; // YES
        partition[1] = 2; // NO

        conditionalTokens.splitPosition(
            collateralToken,
            bytes32(0),
            conditionId,
            partition,
            deficit
        );

        // Final sanity check to ensure enough tokens are now available
        uint256 postBalance = conditionalTokens.balanceOf(
            address(this),
            positionId
        );
        require(postBalance >= requiredAmount, "Insufficient position liquidity");
    }

    /**
     * @dev Decodes an optional recipient address from ERC1155 `data`.
     * If `data` is empty or not a valid address encoding, returns `defaultRecipient`.
     * Supports 32-byte abi-encoded address or raw 20-byte address.
     */
    function _decodeOptionalRecipient(
        bytes calldata data,
        address defaultRecipient
    ) internal pure returns (address) {
        if (data.length == 0) {
            return defaultRecipient;
        }

        if (data.length == 32) {
            // Expect standard abi.encode(address)
            address decoded = abi.decode(data, (address));
            if (decoded != address(0)) {
                return decoded;
            }
            return defaultRecipient;
        }

        if (data.length == 20) {
            address decoded20;
            assembly {
                decoded20 := shr(96, calldataload(data.offset))
            }
            if (decoded20 != address(0)) {
                return decoded20;
            }
            return defaultRecipient;
        }

        return defaultRecipient;
    }

    /**
     * @dev Finalize yield: redeem remaining winning tokens to USDC and supply to AAVE
     */
    function _finalizeYield() internal {
        uint256 remainingWinningTokens;

        if (yesWon) {
            remainingWinningTokens = totalYesDeposits - totalMatched;
        } else {
            remainingWinningTokens = totalNoDeposits - totalMatched;
        }

        if (remainingWinningTokens > 0) {
            // Record USDC balance before redeem
            uint256 usdcBalanceBefore = collateralToken.balanceOf(
                address(this)
            );

            // Prepare redeem parameters
            uint256[] memory indexSets = new uint256[](1);
            indexSets[0] = yesWon ? 1 : 2; // YES=1, NO=2

            // Redeem winning tokens into USDC via ConditionalTokens
            conditionalTokens.redeemPositions(
                collateralToken,
                bytes32(0), // parentCollectionId
                conditionId,
                indexSets
            );

            // Compute USDC received
            uint256 usdcBalanceAfter = collateralToken.balanceOf(address(this));
            uint256 usdcReceived = usdcBalanceAfter - usdcBalanceBefore;

            // Supply received USDC to AAVE to earn yield
            if (usdcReceived > 0) {
                uint256 usdcToSupply;

                if (isWrappedCollateral) {
                    // Unwrap the wrapped collateral to get underlying USDC
                    IWrappedCollateral(address(collateralToken)).unwrap(
                        address(this),
                        usdcReceived
                    );
                    usdcToSupply =
                        underlyingToken.balanceOf(address(this)) -
                        (
                            totalYielding > 0
                                ? aavePool.withdraw(
                                    address(underlyingToken),
                                    type(uint256).max,
                                    address(this)
                                )
                                : 0
                        );

                    // Approve and supply underlying USDC to AAVE
                    underlyingToken.approve(address(aavePool), usdcToSupply);
                    aavePool.supply(
                        address(underlyingToken),
                        usdcToSupply,
                        address(this),
                        0
                    );
                } else {
                    // Supply collateral token directly (it's already USDC)
                    usdcToSupply = usdcReceived;
                    collateralToken.approve(address(aavePool), usdcToSupply);
                    aavePool.supply(
                        address(collateralToken),
                        usdcToSupply,
                        address(this),
                        0
                    );
                }

                totalYielding = totalYielding + usdcToSupply;
            }
        }
    }

    /**
     * @dev Calculate user's USDC amount (including yield)
     */
    function _calculatePayout(
        uint256 yTokenAmount,
        bool isYes
    ) internal view returns (uint256) {
        uint256 totalWinningDeposits = isYes
            ? totalYesDeposits
            : totalNoDeposits;

        // Prevent division by zero
        require(totalWinningDeposits > 0, "No winning deposits");

        // User share relative to total winning deposits
        uint256 userShare = (yTokenAmount * 1e18) / totalWinningDeposits;

        // Current underlying balance represented by aTokens (USDC)
        uint256 totalUnderlyingBalance = aToken.balanceOf(address(this));

        // for estimation withdraw
        if (!isResolved) {
            totalUnderlyingBalance += (totalWinningDeposits - totalMatched);
        }

        // User's USDC entitlement
        uint256 userUSDCAmount = (totalUnderlyingBalance * userShare) / 1e18;

        return userUSDCAmount;
    }

    // ===== View functions =====

    /**
     * @dev Get user's YES.Y balance
     */
    function getYesYBalance(address user) external view returns (uint256) {
        return yesYTokens[user];
    }

    /**
     * @dev Get user's NO.Y balance
     */
    function getNoYBalance(address user) external view returns (uint256) {
        return noYTokens[user];
    }

    /**
     * @dev Get vault yield status
     */
    function getYieldStatus()
        external
        view
        returns (
            uint256 totalATokens,
            uint256 totalCollateral,
            uint256 accruedYield
        )
    {
        totalATokens = aToken.balanceOf(address(this));
        totalCollateral = totalYielding;
        accruedYield = totalATokens > totalCollateral
            ? totalATokens - totalCollateral
            : 0;
    }

    /**
     * @dev Estimate user's withdrawal USDC amount
     */
    function estimateWithdrawal(address user) external view returns (uint256) {
        bool result; // true if YES won, false if NO won
        if (!isResolved) {
            uint256 yesPayoutNumerator = conditionalTokens.payoutNumerators(
                conditionId,
                0
            );
            uint256 noPayoutNumerator = conditionalTokens.payoutNumerators(
                conditionId,
                1
            );
            uint256 payoutDenominator = conditionalTokens.payoutDenominator(
                conditionId
            );

            if (payoutDenominator == 0) {
                return 0; // Market not resolved on Polymarket
            }

            if (yesPayoutNumerator > noPayoutNumerator) {
                result = true;
            } else {
                result = false;
            }
        } else {
            result = yesWon;
        }

        uint256 yesYBalance = yesYTokens[user];
        uint256 noYBalance = noYTokens[user];

        if (result && yesYBalance > 0) {
            return _calculatePayout(yesYBalance, true);
        } else if (!result && noYBalance > 0) {
            return _calculatePayout(noYBalance, false);
        }

        return 0;
    }

    // ===== ERC1155 Receiver implementation =====

    /**
     * @dev ERC1155 single-receive callback
     * Automatically treats incoming YES/NO tokens as deposits
     */
    function onERC1155Received(
        address /* operator */,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external override nonReentrant returns (bytes4) {
        // Ensure sender is ConditionalTokens
        require(
            msg.sender == address(conditionalTokens),
            "Only ConditionalTokens can send tokens"
        );

        // Ensure token id is YES or NO position id
        require(id == yesPositionId || id == noPositionId, "Invalid token ID");

        // Amount must be > 0
        require(value > 0, "Amount must be greater than 0");

        // Market must be unresolved
        require(!isResolved, "Market already resolved");

        // Determine receipt recipient: default to from, allow override via data
        address receiptRecipient = _decodeOptionalRecipient(data, from);

        // Handle deposit by token id (mint transferable receipt)
        if (id == yesPositionId) {
            // Process YES deposit
            yesYTokens[receiptRecipient] = yesYTokens[receiptRecipient] + value;
            totalYesDeposits = totalYesDeposits + value;
            // Mint YES.Y receipt
            receipt.mint(receiptRecipient, yesPositionId, value);

            // Try to match and invest
            _tryMatchAndInvest();

            emit YesTokenDeposited(receiptRecipient, value, value);
        } else if (id == noPositionId) {
            // Process NO deposit
            noYTokens[receiptRecipient] = noYTokens[receiptRecipient] + value;
            totalNoDeposits = totalNoDeposits + value;
            // Mint NO.Y receipt
            receipt.mint(receiptRecipient, noPositionId, value);

            // Try to match and invest
            _tryMatchAndInvest();

            emit NoTokenDeposited(receiptRecipient, value, value);
        }

        // Return ERC1155 single receiver selector
        return this.onERC1155Received.selector;
    }

    /**
     * @dev ERC1155 batch-receive callback
     * Automatically handles batch deposits of YES/NO tokens
     */
    function onERC1155BatchReceived(
        address /* operator */,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external override nonReentrant returns (bytes4) {
        // Ensure sender is ConditionalTokens
        require(
            msg.sender == address(conditionalTokens),
            "Only ConditionalTokens can send tokens"
        );

        // Ensure ids/values length match
        require(ids.length == values.length, "Arrays length mismatch");

        // Market must be unresolved
        require(!isResolved, "Market already resolved");

        // Determine receipt recipient: default to from, allow override via data
        address receiptRecipient = _decodeOptionalRecipient(data, from);

        // Handle batch deposits
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            uint256 value = values[i];

            // Ensure token id is YES or NO position id
            require(
                id == yesPositionId || id == noPositionId,
                "Invalid token ID in batch"
            );

            // Amount must be > 0
            require(value > 0, "Amount must be greater than 0");

            // Handle deposit by token id
            if (id == yesPositionId) {
                // Process YES deposit
                yesYTokens[receiptRecipient] = yesYTokens[receiptRecipient] + value;
                totalYesDeposits = totalYesDeposits + value;
                receipt.mint(receiptRecipient, yesPositionId, value);

                emit YesTokenDeposited(receiptRecipient, value, value);
            } else if (id == noPositionId) {
                // Process NO deposit
                noYTokens[receiptRecipient] = noYTokens[receiptRecipient] + value;
                totalNoDeposits = totalNoDeposits + value;
                receipt.mint(receiptRecipient, noPositionId, value);

                emit NoTokenDeposited(receiptRecipient, value, value);
            }
        }

        // After batch, try to match and invest
        _tryMatchAndInvest();

        // Return the ERC1155 batch receiver selector
        return this.onERC1155BatchReceived.selector;
    }

    /**
     * @dev Whether this contract supports the ERC1155 receiver interface
     */
    function supportsInterface(
        bytes4 interfaceId
    ) external pure override returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId;
    }
}
