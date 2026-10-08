// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20V4Helper {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPoolManagerHelper {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ModifyLiquidityParams {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// @dev Test-only liquidity provider and exact-input swapper for Uniswap V4 pools. Settles from and takes
///      to its OWN balances (ERC20 and native ETH), so it never needs approvals. Also used by the TypeScript
///      e2e tests, which call `swapExactIn` through eth_call as an exact quoter.
contract V4Helper {
    uint160 private constant MIN_SQRT_PRICE = 4295128739;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    IPoolManagerHelper public immutable poolManager;
    /// @dev Set only while this helper's own unlock is in progress.
    bool private transient unlocking;

    enum Action {
        ModifyLiquidity,
        Swap
    }

    constructor(address poolManager_) {
        poolManager = IPoolManagerHelper(poolManager_);
    }

    receive() external payable {}

    function modifyLiquidity(
        IPoolManagerHelper.PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external returns (int256 delta0, int256 delta1) {
        bytes memory params = abi.encode(key, tickLower, tickUpper, liquidityDelta);
        (delta0, delta1) = abi.decode(_unlock(Action.ModifyLiquidity, params), (int256, int256));
    }

    function swapExactIn(IPoolManagerHelper.PoolKey calldata key, bool zeroForOne, uint256 amountIn, address recipient)
        external
        returns (uint256 amountOut)
    {
        bytes memory params = abi.encode(key, zeroForOne, amountIn, recipient);
        amountOut = abi.decode(_unlock(Action.Swap, params), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager) && unlocking, "V4Helper: unexpected callback");
        (Action action, bytes memory params) = abi.decode(data, (Action, bytes));
        if (action == Action.ModifyLiquidity) {
            (IPoolManagerHelper.PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidityDelta) =
                abi.decode(params, (IPoolManagerHelper.PoolKey, int24, int24, int256));
            (int256 delta,) = poolManager.modifyLiquidity(
                key, IPoolManagerHelper.ModifyLiquidityParams(tickLower, tickUpper, liquidityDelta, bytes32(0)), ""
            );
            (int256 delta0, int256 delta1) = _split(delta);
            _resolve(key.currency0, delta0, address(this));
            _resolve(key.currency1, delta1, address(this));
            return abi.encode(delta0, delta1);
        }
        (IPoolManagerHelper.PoolKey memory k, bool zeroForOne, uint256 amountIn, address recipient) =
            abi.decode(params, (IPoolManagerHelper.PoolKey, bool, uint256, address));
        int256 swapDelta = poolManager.swap(
            k,
            IPoolManagerHelper.SwapParams(
                zeroForOne,
                // forge-lint: disable-next-line(unsafe-typecast) test helper
                -int256(amountIn),
                zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            ),
            ""
        );
        (int256 d0, int256 d1) = _split(swapDelta);
        _resolve(k.currency0, d0, recipient);
        _resolve(k.currency1, d1, recipient);
        // forge-lint: disable-next-line(unsafe-typecast) the output delta of an exact-input swap is >= 0
        return abi.encode(uint256(zeroForOne ? d1 : d0));
    }

    function _unlock(Action action, bytes memory params) private returns (bytes memory) {
        unlocking = true;
        bytes memory result = poolManager.unlock(abi.encode(action, params));
        unlocking = false;
        return result;
    }

    /// @dev Pays a negative delta from this helper's balance, takes a positive one to `to`.
    function _resolve(address currency, int256 delta, address to) private {
        if (delta < 0) {
            uint256 amount = uint256(-delta);
            if (currency == address(0)) {
                poolManager.settle{value: amount}();
            } else {
                poolManager.sync(currency);
                require(IERC20V4Helper(currency).transfer(address(poolManager), amount));
                poolManager.settle();
            }
        } else if (delta > 0) {
            poolManager.take(currency, to, uint256(delta));
        }
    }

    function _split(int256 delta) private pure returns (int256 delta0, int256 delta1) {
        // forge-lint: disable-next-line(unsafe-typecast) BalanceDelta packs two int128s
        delta0 = int128(delta >> 128);
        // forge-lint: disable-next-line(unsafe-typecast) BalanceDelta packs two int128s
        delta1 = int128(delta);
    }
}
