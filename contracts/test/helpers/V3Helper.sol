// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20V3Helper {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IV3PoolHelper {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function burn(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256 amount0, uint256 amount1);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @dev Test-only liquidity provider and exact-input swapper for Uniswap V3 style pools. It pays from its
///      OWN token balances (fund it first), so it never needs approvals. Also used by the TypeScript e2e
///      tests, which call `swapExactIn` through eth_call as an exact quoter.
contract V3Helper {
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// @dev The pool this helper is currently calling: the only one whose callbacks it pays.
    address private transient activePool;

    function mint(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        activePool = pool;
        (amount0, amount1) = IV3PoolHelper(pool).mint(address(this), tickLower, tickUpper, liquidity, "");
        activePool = address(0);
    }

    /// @dev Burns the helper's own position. The tokens stay owed to the position (not collected).
    function burn(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        (amount0, amount1) = IV3PoolHelper(pool).burn(tickLower, tickUpper, liquidity);
    }

    function swapExactIn(address pool, bool zeroForOne, uint256 amountIn, address recipient)
        external
        returns (uint256 amountOut)
    {
        activePool = pool;
        (int256 amount0, int256 amount1) = IV3PoolHelper(pool)
            .swap(
                recipient,
                zeroForOne,
                // forge-lint: disable-next-line(unsafe-typecast) test helper
                int256(amountIn),
                zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                ""
            );
        activePool = address(0);
        amountOut = uint256(-(zeroForOne ? amount1 : amount0));
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        _pay(amount0Owed, amount1Owed);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _pay(amount0Delta > 0 ? uint256(amount0Delta) : 0, amount1Delta > 0 ? uint256(amount1Delta) : 0);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _pay(amount0Delta > 0 ? uint256(amount0Delta) : 0, amount1Delta > 0 ? uint256(amount1Delta) : 0);
    }

    function _pay(uint256 amount0, uint256 amount1) private {
        require(msg.sender == activePool && msg.sender != address(0), "V3Helper: unexpected callback");
        if (amount0 > 0) require(IERC20V3Helper(IV3PoolHelper(msg.sender).token0()).transfer(msg.sender, amount0));
        if (amount1 > 0) require(IERC20V3Helper(IV3PoolHelper(msg.sender).token1()).transfer(msg.sender, amount1));
    }
}
