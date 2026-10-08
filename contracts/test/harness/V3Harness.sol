// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;

// Test-only harnesses that let the bot's TypeScript CL math be checked bit-for-bit against the real
// Uniswap V3 libraries, a real UniswapV3Pool and a real V4 PoolManager pool (see
// bot/test/parity/clmath-parity.test.ts).

import "v3-core/interfaces/IUniswapV3Factory.sol";
import "v3-core/interfaces/IUniswapV3Pool.sol";
import "v3-core/interfaces/callback/IUniswapV3MintCallback.sol";
import "v3-core/interfaces/callback/IUniswapV3SwapCallback.sol";
import "v3-core/libraries/TickMath.sol";
import "v3-core/libraries/SqrtPriceMath.sol";
import "v3-core/libraries/SwapMath.sol";

/// @notice Exposes the real V3 math libraries as external pure functions.
contract V3MathHarness {
    function getSqrtRatioAtTick(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(tick);
    }

    function getTickAtSqrtRatio(uint160 sqrtPriceX96) external pure returns (int24) {
        return TickMath.getTickAtSqrtRatio(sqrtPriceX96);
    }

    function getAmount0Delta(uint160 sqrtA, uint160 sqrtB, uint128 liquidity, bool roundUp)
        external
        pure
        returns (uint256)
    {
        return SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp);
    }

    function getAmount1Delta(uint160 sqrtA, uint160 sqrtB, uint128 liquidity, bool roundUp)
        external
        pure
        returns (uint256)
    {
        return SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp);
    }

    function getNextSqrtPriceFromInput(uint160 sqrtPX96, uint128 liquidity, uint256 amountIn, bool zeroForOne)
        external
        pure
        returns (uint160)
    {
        return SqrtPriceMath.getNextSqrtPriceFromInput(sqrtPX96, liquidity, amountIn, zeroForOne);
    }

    function computeSwapStep(
        uint160 sqrtRatioCurrentX96,
        uint160 sqrtRatioTargetX96,
        uint128 liquidity,
        int256 amountRemaining,
        uint24 feePips
    ) external pure returns (uint160 sqrtRatioNextX96, uint256 amountIn, uint256 amountOut, uint256 feeAmount) {
        return SwapMath.computeSwapStep(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, amountRemaining, feePips);
    }
}

/// @notice Minimal mintable token; only its deployer (the pool harness) can mint, so it can pay any amount.
contract V3HarnessToken {
    address public immutable minter;
    mapping(address => uint256) public balanceOf;

    constructor() {
        minter = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "minter");
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Owns a real UniswapV3Pool between two fresh tokens and drives mints, burns and swaps on it.
/// Callbacks pay by minting straight to the pool, so positions and swaps of any size can be funded.
contract V3PoolHarness is IUniswapV3MintCallback, IUniswapV3SwapCallback {
    IUniswapV3Pool public immutable pool;
    V3HarnessToken public immutable token0;
    V3HarnessToken public immutable token1;

    constructor(IUniswapV3Factory factory, uint24 fee, uint160 sqrtPriceX96) {
        V3HarnessToken a = new V3HarnessToken();
        V3HarnessToken b = new V3HarnessToken();
        (V3HarnessToken t0, V3HarnessToken t1) = address(a) < address(b) ? (a, b) : (b, a);
        IUniswapV3Pool p = IUniswapV3Pool(factory.createPool(address(t0), address(t1), fee));
        p.initialize(sqrtPriceX96);
        pool = p;
        token0 = t0;
        token1 = t1;
    }

    function mint(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256, uint256) {
        return pool.mint(address(this), tickLower, tickUpper, amount, "");
    }

    function burn(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256, uint256) {
        return pool.burn(tickLower, tickUpper, amount);
    }

    /// @notice Exact-input swap to the extreme price limit. eth_call it to use the real pool as an exact quoter.
    function swapExactIn(bool zeroForOne, uint256 amountIn)
        external
        returns (uint256 amountInUsed, uint256 amountOut, uint160 sqrtPriceX96, int24 tick, uint128 liquidity)
    {
        (int256 amount0, int256 amount1) = pool.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
            ""
        );
        (amountInUsed, amountOut) = zeroForOne
            ? (uint256(amount0), uint256(-amount1))
            : (uint256(amount1), uint256(-amount0));
        (sqrtPriceX96, tick, , , , , ) = pool.slot0();
        liquidity = pool.liquidity();
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external override {
        require(msg.sender == address(pool), "pool");
        if (amount0Owed > 0) token0.mint(msg.sender, amount0Owed);
        if (amount1Owed > 0) token1.mint(msg.sender, amount1Owed);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        require(msg.sender == address(pool), "pool");
        if (amount0Delta > 0) token0.mint(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) token1.mint(msg.sender, uint256(amount1Delta));
    }

    /// @notice Pool state plus every initialized tick in bitmap words [wordLo, wordHi], read from the real pool.
    function snapshot(int16 wordLo, int16 wordHi)
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint128 liquidity,
            int24[] memory ticks,
            uint128[] memory gross,
            int128[] memory net
        )
    {
        (sqrtPriceX96, tick, , , , , ) = pool.slot0();
        liquidity = pool.liquidity();
        int24 spacing = pool.tickSpacing();

        uint256 count;
        for (int256 w = wordLo; w <= wordHi; w++) count += popcount(pool.tickBitmap(int16(w)));
        ticks = new int24[](count);
        gross = new uint128[](count);
        net = new int128[](count);

        uint256 i;
        for (int256 w = wordLo; w <= wordHi; w++) {
            uint256 bits = pool.tickBitmap(int16(w));
            for (uint256 bit = 0; bits != 0; bit++) {
                if (bits & 1 != 0) {
                    int24 t = int24((w * 256 + int256(bit)) * spacing);
                    ticks[i] = t;
                    (gross[i], net[i], , , , , , ) = pool.ticks(t);
                    i++;
                }
                bits >>= 1;
            }
        }
    }

    function popcount(uint256 x) private pure returns (uint256 n) {
        for (; x != 0; x &= x - 1) n++;
    }
}

interface IV4Extsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @notice Same interface as V3PoolHarness, but over a real Uniswap V4 pool (no hooks, static fee) in a real
/// PoolManager. Liquidity and swaps go through the repo's V4Helper (test/helpers/V4Helper.sol, 0.8.28),
/// which settles from its own balances, so this mints whatever it is about to need straight to the helper.
/// PoolKey is a static tuple, so its ABI encoding is the flattened fields and abicoder v1 can pass it.
/// State is read through extsload with the layout of v4-core's StateLibrary.
contract V4PoolHarness {
    // StateLibrary: pools mapping slot and Pool.State member offsets.
    uint256 private constant POOLS_SLOT = 6;
    uint256 private constant LIQUIDITY_OFFSET = 3;
    uint256 private constant TICKS_OFFSET = 4;
    uint256 private constant TICK_BITMAP_OFFSET = 5;
    string private constant KEY = "(address,address,uint24,int24,address)";

    address public immutable manager;
    address public immutable helper;
    V3HarnessToken public immutable token0;
    V3HarnessToken public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    bytes32 public immutable stateSlot;

    constructor(address manager_, address helper_, uint24 fee_, int24 tickSpacing_, uint160 sqrtPriceX96) {
        V3HarnessToken a = new V3HarnessToken();
        V3HarnessToken b = new V3HarnessToken();
        (V3HarnessToken t0, V3HarnessToken t1) = address(a) < address(b) ? (a, b) : (b, a);
        manager = manager_;
        helper = helper_;
        token0 = t0;
        token1 = t1;
        fee = fee_;
        tickSpacing = tickSpacing_;
        bytes32 poolId = keccak256(abi.encode(t0, t1, fee_, tickSpacing_, address(0)));
        stateSlot = keccak256(abi.encodePacked(poolId, POOLS_SLOT));
        exec(
            manager_,
            abi.encodeWithSignature(
                string(abi.encodePacked("initialize(", KEY, ",uint160)")),
                t0,
                t1,
                fee_,
                tickSpacing_,
                address(0),
                sqrtPriceX96
            )
        );
    }

    function mint(int24 tickLower, int24 tickUpper, uint128 amount) external {
        modify(tickLower, tickUpper, int256(amount));
    }

    function burn(int24 tickLower, int24 tickUpper, uint128 amount) external {
        modify(tickLower, tickUpper, -int256(amount));
    }

    /// @notice Exact-input swap to the extreme price limit; same outputs as V3PoolHarness.swapExactIn.
    function swapExactIn(bool zeroForOne, uint256 amountIn)
        external
        returns (uint256 amountInUsed, uint256 amountOut, uint160 sqrtPriceX96, int24 tick, uint128 liquidity)
    {
        V3HarnessToken tokenIn = zeroForOne ? token0 : token1;
        tokenIn.mint(helper, amountIn);
        uint256 before = tokenIn.balanceOf(helper);
        bytes memory ret = withKey("swapExactIn", ",bool,uint256,address", abi.encode(zeroForOne, amountIn, address(this)));
        amountOut = abi.decode(ret, (uint256));
        amountInUsed = before - tokenIn.balanceOf(helper);
        (sqrtPriceX96, tick, liquidity) = slot0();
    }

    /// @notice Same as V3PoolHarness.snapshot, read from the PoolManager's storage.
    function snapshot(int16 wordLo, int16 wordHi)
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint128 liquidity,
            int24[] memory ticks,
            uint128[] memory gross,
            int128[] memory net
        )
    {
        (sqrtPriceX96, tick, liquidity) = slot0();
        uint256 count;
        for (int256 w = wordLo; w <= wordHi; w++) count += popcount(bitmap(w));
        ticks = new int24[](count);
        gross = new uint128[](count);
        net = new int128[](count);

        uint256 i;
        for (int256 w = wordLo; w <= wordHi; w++) {
            uint256 bits = bitmap(w);
            for (uint256 bit = 0; bits != 0; bit++) {
                if (bits & 1 != 0) {
                    int24 t = int24((w * 256 + int256(bit)) * tickSpacing);
                    uint256 info = load(keccak256(abi.encode(int256(t), uint256(stateSlot) + TICKS_OFFSET)));
                    ticks[i] = t;
                    gross[i] = uint128(info);
                    net[i] = int128(int256(info) >> 128);
                    i++;
                }
                bits >>= 1;
            }
        }
    }

    function modify(int24 tickLower, int24 tickUpper, int256 liquidityDelta) private {
        // Ample for any position the tests mint (V4 caps deltas at int128 anyway).
        token0.mint(helper, 1 << 130);
        token1.mint(helper, 1 << 130);
        withKey("modifyLiquidity", ",int24,int24,int256", abi.encode(tickLower, tickUpper, liquidityDelta));
    }

    function slot0() private view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity) {
        uint256 data = load(stateSlot);
        sqrtPriceX96 = uint160(data);
        tick = int24(uint24(data >> 160));
        liquidity = uint128(load(bytes32(uint256(stateSlot) + LIQUIDITY_OFFSET)));
    }

    function bitmap(int256 word) private view returns (uint256) {
        return load(keccak256(abi.encode(word, uint256(stateSlot) + TICK_BITMAP_OFFSET)));
    }

    function load(bytes32 slot) private view returns (uint256) {
        return uint256(IV4Extsload(manager).extsload(slot));
    }

    /// @dev Calls V4Helper.`fn`(PoolKey, ...rest) with this pool's key followed by the ABI-encoded `args`.
    function withKey(string memory fn, string memory rest, bytes memory args) private returns (bytes memory) {
        bytes4 selector = bytes4(keccak256(abi.encodePacked(fn, "(", KEY, rest, ")")));
        return exec(helper, abi.encodePacked(selector, abi.encode(token0, token1, fee, tickSpacing, address(0)), args));
    }

    /// @dev Calls `target`, bubbling up its revert data unchanged.
    function exec(address target, bytes memory data) private returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function popcount(uint256 x) private pure returns (uint256 n) {
        for (; x != 0; x &= x - 1) n++;
    }
}
