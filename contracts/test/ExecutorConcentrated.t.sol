// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Executor} from "../src/Executor.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockV2Factory} from "./mocks/MockV2.sol";
import {V3Helper} from "./helpers/V3Helper.sol";
import {V4Helper, IPoolManagerHelper} from "./helpers/V4Helper.sol";

interface IV3FactoryLike {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface IV3PoolInit {
    function initialize(uint160 sqrtPriceX96) external;
}

interface IPoolManagerInit {
    function initialize(IPoolManagerHelper.PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
}

interface IV2Reserves {
    function getReserves() external view returns (uint256, uint256, uint256);
}

interface IBalance {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @dev Pretends to be a V3 pool and scripts its callbacks: demands `demand` of the input token `calls`
///      times, then reports `claimedOut` of output without paying anything.
contract EvilV3Pool {
    int256 public demand;
    uint256 public calls;
    int256 public claimedOut;

    function configure(int256 demand_, uint256 calls_, int256 claimedOut_) external {
        demand = demand_;
        calls = calls_;
        claimedOut = claimedOut_;
    }

    function swap(address, bool zeroForOne, int256, uint160, bytes calldata)
        external
        returns (int256 amount0, int256 amount1)
    {
        (amount0, amount1) = zeroForOne ? (demand, -claimedOut) : (-claimedOut, demand);
        for (uint256 i; i < calls; ++i) {
            Executor(payable(msg.sender)).uniswapV3SwapCallback(amount0, amount1, "");
        }
    }

    /// @dev Lets a pool from an earlier hop try to collect during someone else's hop.
    function strike(address executor, int256 amount0, int256 amount1) external {
        Executor(payable(executor)).uniswapV3SwapCallback(amount0, amount1, "");
    }
}

/// @dev Instead of calling back itself, has the pool of an earlier hop ask for the payment.
contract CrossHopV3Pool {
    EvilV3Pool public immutable accomplice;

    constructor(EvilV3Pool accomplice_) {
        accomplice = accomplice_;
    }

    function swap(address, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata)
        external
        returns (int256, int256)
    {
        accomplice.strike(
            msg.sender, zeroForOne ? amountSpecified : int256(0), zeroForOne ? int256(0) : amountSpecified
        );
        return (0, 0);
    }
}

/// @dev PancakeSwap V3 calls `pancakeV3SwapCallback` instead of `uniswapV3SwapCallback`. Pays `rate` units
///      out per unit in (either direction) from its own balance and checks it was paid, like a real pool.
contract PancakeStylePool {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable rate;

    constructor(address token0_, address token1_, uint256 rate_) {
        (token0, token1) = token0_ < token1_ ? (token0_, token1_) : (token1_, token0_);
        rate = rate_;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        // forge-lint: disable-next-line(unsafe-typecast) test mock: exact input only
        uint256 amountIn = uint256(amountSpecified);
        uint256 amountOut = amountIn * rate;
        (address tokenIn, address tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        // forge-lint: disable-next-line(unsafe-typecast) test mock: small amounts
        int256 paid = -int256(amountOut);
        (amount0, amount1) = zeroForOne ? (amountSpecified, paid) : (paid, amountSpecified);
        require(IBalance(tokenOut).transfer(recipient, amountOut));
        uint256 balanceBefore = IBalance(tokenIn).balanceOf(address(this));
        PancakeCallee(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        require(IBalance(tokenIn).balanceOf(address(this)) >= balanceBefore + amountIn, "IIA");
    }
}

interface PancakeCallee {
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @dev A V4 hook (BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA) that takes the whole exact input for itself
///      and returns nothing to the swapper.
contract StealingHook {
    IPoolManagerHelper public immutable manager;
    address public immutable thief;

    constructor(address manager_, address thief_) {
        manager = IPoolManagerHelper(manager_);
        thief = thief_;
    }

    function beforeSwap(
        address,
        IPoolManagerHelper.PoolKey calldata key,
        IPoolManagerHelper.SwapParams calldata params,
        bytes calldata
    ) external returns (bytes4, int256, uint24) {
        uint256 amount = uint256(-params.amountSpecified);
        manager.take(params.zeroForOne ? key.currency0 : key.currency1, thief, amount);
        // BeforeSwapDelta: the specified-currency delta lives in the upper 128 bits.
        return (StealingHook.beforeSwap.selector, int256(amount) << 128, 0);
    }
}

/// @dev A V4 hook (BEFORE_SWAP only) that, mid-swap, tries to re-enter the executor's callbacks and
///      records the error each attempt got. It otherwise leaves the swap alone.
contract ReentrantHook {
    address public immutable executor;
    bytes4 public unlockCallbackError;
    bytes4 public v3CallbackError;
    bytes4 public pancakeCallbackError;

    constructor(address executor_) {
        executor = executor_;
    }

    function beforeSwap(
        address,
        IPoolManagerHelper.PoolKey calldata key,
        IPoolManagerHelper.SwapParams calldata,
        bytes calldata
    ) external returns (bytes4, int256, uint24) {
        Executor.Hop memory steal = Executor.Hop(2, key.hooks, key.currency1, key.currency0, key.fee, 60, false, 0);
        unlockCallbackError = _attempt(abi.encodeCall(Executor.unlockCallback, (abi.encode(steal, 1 ether))));
        v3CallbackError = _attempt(abi.encodeCall(Executor.uniswapV3SwapCallback, (1 ether, 1 ether, "")));
        pancakeCallbackError = _attempt(abi.encodeCall(Executor.pancakeV3SwapCallback, (1 ether, 1 ether, "")));
        return (ReentrantHook.beforeSwap.selector, 0, 0);
    }

    function _attempt(bytes memory call) private returns (bytes4) {
        (bool ok, bytes memory err) = executor.call(call);
        // forge-lint: disable-next-line(unsafe-typecast) the selector is the first 4 bytes of the revert data
        return ok ? bytes4(0xffffffff) : bytes4(err);
    }
}

/// @dev Executor v2 against the REAL Uniswap V3 factory/pools and the REAL Uniswap V4 PoolManager.
///      Expected outputs are measured independently with the test helpers inside a state snapshot.
contract ExecutorConcentratedTest is Test {
    uint24 internal constant FEE = 3000; // 0.30%: tick spacing 60 on both V3 and V4
    int24 internal constant SPACING = 60;
    int24 internal constant WIDTH = 6000; // positions span ~+-82% around the start price
    int24 internal constant TICK_2992 = 80_040; // 1.0001^80040 ~= 2992: WETH priced in an 18-dec token
    int24 internal constant TICK_2700 = 79_020; // ~= 2700
    uint128 internal constant LIQUIDITY = 1e23;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal attacker = makeAddr("attacker");

    MockWETH internal weth;
    MockERC20 internal tka;
    MockERC20 internal tkb;
    MockV2Factory internal uni;
    address internal v3Factory;
    address internal manager;
    V3Helper internal v3;
    V4Helper internal v4;
    Executor internal executor;

    receive() external payable {}

    function setUp() public {
        weth = new MockWETH();
        tka = new MockERC20("Token A", "TKA", 18);
        tkb = new MockERC20("Token B", "TKB", 18);
        uni = new MockV2Factory(30);
        v3Factory = deployCode("out/UniswapV3Factory.sol/UniswapV3Factory.json");
        manager = deployCode("out/PoolManager.sol/PoolManager.json", abi.encode(owner));
        v3 = new V3Helper();
        v4 = new V4Helper(manager);
        executor = new Executor(owner, operator, manager, address(weth));

        // Real (ETH-backed) WETH inventory so native-ETH hops can unwrap it.
        vm.deal(address(this), 50 ether);
        weth.deposit{value: 50 ether}();
        weth.transfer(address(executor), 50 ether);

        // LP / quoting inventory for the helpers.
        for (uint256 i; i < 2; ++i) {
            address helper = i == 0 ? address(v3) : address(v4);
            weth.mint(helper, 1e30);
            tka.mint(helper, 1e30);
            tkb.mint(helper, 1e30);
        }
        vm.deal(address(v4), 1e30);
    }

    // ---------------------------------------------------------------- pool setup

    function _v2Pool(MockERC20 a, uint256 amountA, address b, uint256 amountB) internal returns (address pool) {
        pool = uni.createPair(address(a), b);
        a.mint(pool, amountA);
        if (b == address(weth)) weth.mint(pool, amountB);
        else MockERC20(b).mint(pool, amountB);
        (bool ok,) = pool.call(abi.encodeWithSignature("sync()"));
        require(ok);
    }

    /// @dev `tickAinB` prices `a` in units of `b` (1.0001^tick); must be a multiple of SPACING.
    function _v3Pool(address a, address b, int24 tickAinB, uint128 liquidity, int24 width)
        internal
        returns (address pool)
    {
        pool = IV3FactoryLike(v3Factory).createPool(a, b, FEE);
        int24 tick = a < b ? tickAinB : -tickAinB;
        IV3PoolInit(pool).initialize(TickMath.getSqrtPriceAtTick(tick));
        v3.mint(pool, tick - width, tick + width, liquidity);
    }

    /// @dev Hookless V4 pool; `a`/`b` may be address(0) for native ETH.
    function _v4Pool(address a, address b, int24 tickAinB, uint128 liquidity)
        internal
        returns (IPoolManagerHelper.PoolKey memory key)
    {
        key = _key(a, b, address(0));
        int24 tick = a < b ? tickAinB : -tickAinB;
        IPoolManagerInit(manager).initialize(key, TickMath.getSqrtPriceAtTick(tick));
        // forge-lint: disable-next-line(unsafe-typecast)
        v4.modifyLiquidity(key, tick - WIDTH, tick + WIDTH, int256(uint256(liquidity)));
    }

    function _key(address a, address b, address hooks) internal pure returns (IPoolManagerHelper.PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return IPoolManagerHelper.PoolKey(c0, c1, FEE, SPACING, hooks);
    }

    // ---------------------------------------------------------------- hops

    function _v2Hop(address pool, address tokenIn, address tokenOut) internal pure returns (Executor.Hop memory) {
        return Executor.Hop(0, pool, tokenIn, tokenOut, 30, 0, tokenIn < tokenOut, 0);
    }

    function _v3Hop(address pool, address tokenIn, address tokenOut) internal pure returns (Executor.Hop memory) {
        return Executor.Hop(1, pool, tokenIn, tokenOut, 0, 0, tokenIn < tokenOut, 0);
    }

    function _v4Hop(IPoolManagerHelper.PoolKey memory key, address tokenIn, address tokenOut, uint8 flags)
        internal
        pure
        returns (Executor.Hop memory)
    {
        address currencyIn = flags & 1 != 0 ? address(0) : tokenIn;
        address currencyOut = flags & 2 != 0 ? address(0) : tokenOut;
        return Executor.Hop(2, key.hooks, tokenIn, tokenOut, key.fee, key.tickSpacing, currencyIn < currencyOut, flags);
    }

    function _route(Executor.Hop memory a, Executor.Hop memory b) internal pure returns (Executor.Hop[] memory hops) {
        hops = new Executor.Hop[](2);
        hops[0] = a;
        hops[1] = b;
    }

    // ---------------------------------------------------------------- independent measurement

    /// @dev Constant-product output of a 0.30% V2 pair, from live reserves.
    function _v2Out(address pool, address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        (uint256 r0, uint256 r1,) = IV2Reserves(pool).getReserves();
        (uint256 rIn, uint256 rOut) = tokenIn < tokenOut ? (r0, r1) : (r1, r0);
        uint256 inWithFee = amountIn * 9970;
        return (inWithFee * rOut) / (rIn * 10_000 + inWithFee);
    }

    /// @dev Executes the V2 swap for real so later measured hops see the moved reserves.
    function _v2Swap(address pool, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 out) {
        out = _v2Out(pool, tokenIn, tokenOut, amountIn);
        if (tokenIn == address(weth)) weth.mint(pool, amountIn);
        else MockERC20(tokenIn).mint(pool, amountIn);
        (uint256 a0, uint256 a1) = tokenIn < tokenOut ? (uint256(0), out) : (out, uint256(0));
        (bool ok,) =
            pool.call(abi.encodeWithSignature("swap(uint256,uint256,address,bytes)", a0, a1, address(this), ""));
        require(ok, "v2 measure");
    }

    function _assertClean(uint256 wethBefore, uint256 profit) internal view {
        assertEq(weth.balanceOf(address(executor)), wethBefore + profit, "weth grew by exactly the profit");
        assertEq(tka.balanceOf(address(executor)), 0, "no leftover TKA");
        assertEq(tkb.balanceOf(address(executor)), 0, "no leftover TKB");
        assertEq(address(executor).balance, 0, "no leftover ETH");
    }

    function _run(uint256 amountIn, Executor.Hop[] memory hops) internal returns (uint256 profit) {
        vm.prank(operator);
        profit = executor.run(address(weth), amountIn, 1, hops);
    }

    // ---------------------------------------------------------------- V2 <-> V3

    /// @dev v3First: sell WETH on V3 (~2992) and buy back on V2 (2700). Otherwise sell on V2 (3300) and buy
    ///      back on V3. Token order is fixed, so the V3 hop runs zeroForOne in one case and oneForZero in the other.
    function _v2v3(bool v3First) internal {
        address pool3 = _v3Pool(address(weth), address(tka), TICK_2992, LIQUIDITY, WIDTH);
        address pool2 = _v2Pool(tka, v3First ? 2_700_000 ether : 3_300_000 ether, address(weth), 1000 ether);
        uint256 amountIn = 2 ether;

        Executor.Hop[] memory hops = v3First
            ? _route(_v3Hop(pool3, address(weth), address(tka)), _v2Hop(pool2, address(tka), address(weth)))
            : _route(_v2Hop(pool2, address(weth), address(tka)), _v3Hop(pool3, address(tka), address(weth)));

        uint256 snap = vm.snapshotState();
        uint256 out;
        if (v3First) {
            uint256 mid = v3.swapExactIn(pool3, address(weth) < address(tka), amountIn, address(this));
            out = _v2Out(pool2, address(tka), address(weth), mid);
        } else {
            uint256 mid = _v2Swap(pool2, address(weth), address(tka), amountIn);
            out = v3.swapExactIn(pool3, address(tka) < address(weth), mid, address(this));
        }
        vm.revertToState(snap);
        assertGt(out, amountIn, "route is profitable");

        uint256 before = weth.balanceOf(address(executor));
        uint256 profit = _run(amountIn, hops);
        assertEq(profit, out - amountIn);
        _assertClean(before, profit);
        assertEq(weth.allowance(address(executor), pool3), 0);
        assertEq(tka.allowance(address(executor), pool3), 0);
    }

    function test_v3ThenV2Arbitrage() public {
        _v2v3(true);
    }

    function test_v2ThenV3Arbitrage() public {
        _v2v3(false);
    }

    // ---------------------------------------------------------------- V4

    function test_v4Erc20PoolRoute() public {
        IPoolManagerHelper.PoolKey memory key = _v4Pool(address(weth), address(tka), TICK_2992, LIQUIDITY);
        address pool2 = _v2Pool(tka, 2_700_000 ether, address(weth), 1000 ether);
        uint256 amountIn = 2 ether;

        uint256 snap = vm.snapshotState();
        uint256 mid = v4.swapExactIn(key, address(weth) < address(tka), amountIn, address(this));
        uint256 out = _v2Out(pool2, address(tka), address(weth), mid);
        vm.revertToState(snap);
        assertGt(out, amountIn);

        uint256 before = weth.balanceOf(address(executor));
        uint256 profit = _run(
            amountIn, _route(_v4Hop(key, address(weth), address(tka), 0), _v2Hop(pool2, address(tka), address(weth)))
        );
        assertEq(profit, out - amountIn);
        _assertClean(before, profit);
        assertEq(weth.allowance(address(executor), manager), 0);
    }

    /// @dev WETH is unwrapped and paid into an ETH/TKA pool as native ETH.
    function test_v4NativeInputRoute() public {
        IPoolManagerHelper.PoolKey memory key = _v4Pool(address(0), address(tka), TICK_2992, LIQUIDITY);
        address pool2 = _v2Pool(tka, 2_700_000 ether, address(weth), 1000 ether);
        uint256 amountIn = 2 ether;

        uint256 snap = vm.snapshotState();
        uint256 mid = v4.swapExactIn(key, true, amountIn, address(this));
        uint256 out = _v2Out(pool2, address(tka), address(weth), mid);
        vm.revertToState(snap);
        assertGt(out, amountIn);

        uint256 wethEthBefore = address(weth).balance;
        uint256 before = weth.balanceOf(address(executor));
        uint256 profit = _run(
            amountIn, _route(_v4Hop(key, address(weth), address(tka), 1), _v2Hop(pool2, address(tka), address(weth)))
        );
        assertEq(profit, out - amountIn);
        _assertClean(before, profit);
        assertEq(address(weth).balance, wethEthBefore - amountIn, "input really left as native ETH");
    }

    /// @dev Native ETH taken from an ETH/TKA pool is wrapped back into WETH.
    function test_v4NativeOutputRoute() public {
        IPoolManagerHelper.PoolKey memory key = _v4Pool(address(0), address(tka), TICK_2992, LIQUIDITY);
        address pool2 = _v2Pool(tka, 3_300_000 ether, address(weth), 1000 ether);
        uint256 amountIn = 2 ether;

        uint256 snap = vm.snapshotState();
        uint256 mid = _v2Swap(pool2, address(weth), address(tka), amountIn);
        uint256 out = v4.swapExactIn(key, false, mid, address(this));
        vm.revertToState(snap);
        assertGt(out, amountIn);

        uint256 wethEthBefore = address(weth).balance;
        uint256 before = weth.balanceOf(address(executor));
        uint256 profit = _run(
            amountIn, _route(_v2Hop(pool2, address(weth), address(tka)), _v4Hop(key, address(tka), address(weth), 2))
        );
        assertEq(profit, out - amountIn);
        _assertClean(before, profit);
        assertEq(address(weth).balance, wethEthBefore + out, "output really arrived as native ETH");
    }

    function test_threeHopV2V3V4Route() public {
        // WETH sells for 3000 TKA on V2, TKA:TKB is 1:1 on V3, WETH costs only ~2700 TKB on V4.
        address pool2 = _v2Pool(tka, 3_000_000 ether, address(weth), 1000 ether);
        address pool3 = _v3Pool(address(tka), address(tkb), 0, 1e24, WIDTH);
        IPoolManagerHelper.PoolKey memory key = _v4Pool(address(weth), address(tkb), TICK_2700, LIQUIDITY);
        uint256 amountIn = 1 ether;

        uint256 snap = vm.snapshotState();
        uint256 a1 = _v2Swap(pool2, address(weth), address(tka), amountIn);
        uint256 a2 = v3.swapExactIn(pool3, address(tka) < address(tkb), a1, address(this));
        uint256 out = v4.swapExactIn(key, address(tkb) < address(weth), a2, address(this));
        vm.revertToState(snap);
        assertGt(out, amountIn);

        Executor.Hop[] memory hops = new Executor.Hop[](3);
        hops[0] = _v2Hop(pool2, address(weth), address(tka));
        hops[1] = _v3Hop(pool3, address(tka), address(tkb));
        hops[2] = _v4Hop(key, address(tkb), address(weth), 0);
        uint256 before = weth.balanceOf(address(executor));
        uint256 profit = _run(amountIn, hops);
        assertEq(profit, out - amountIn);
        assertGt(profit, 0.05 ether);
        _assertClean(before, profit);
    }

    // ---------------------------------------------------------------- callback attacks

    function test_v3CallbackRejectsStrangers() public {
        vm.prank(attacker);
        vm.expectRevert(Executor.Unauthorized.selector);
        executor.uniswapV3SwapCallback(1 ether, 0, "");
        vm.prank(attacker);
        vm.expectRevert(Executor.Unauthorized.selector);
        executor.pancakeV3SwapCallback(0, 1 ether, "");

        // A real pool the executor has traded with cannot call back outside of its hop either.
        test_v3ThenV2Arbitrage();
        address pool3 = IV3FactoryLikeView(v3Factory).getPool(address(weth), address(tka), FEE);
        vm.prank(pool3);
        vm.expectRevert(Executor.Unauthorized.selector);
        executor.uniswapV3SwapCallback(1 ether, 1 ether, "");
    }

    function test_v3CallbackRejectsOverpayment() public {
        EvilV3Pool evil = new EvilV3Pool();
        address pool2 = _v2Pool(tka, 2_700_000 ether, address(weth), 1000 ether);
        uint256 amountIn = 1 ether;
        evil.configure(int256(amountIn) + 1, 1, 3000 ether);

        vm.prank(operator);
        vm.expectRevert(Executor.Unauthorized.selector);
        executor.run(
            address(weth),
            amountIn,
            0,
            _route(_v3Hop(address(evil), address(weth), address(tka)), _v2Hop(pool2, address(tka), address(weth)))
        );
        assertEq(weth.balanceOf(address(executor)), 50 ether);
    }

    function test_v3CallbackIsOneShot() public {
        EvilV3Pool evil = new EvilV3Pool();
        address pool2 = _v2Pool(tka, 2_700_000 ether, address(weth), 1000 ether);
        uint256 amountIn = 1 ether;
        // Each demand is within amountIn; together they are not.
        evil.configure(int256(amountIn) / 2, 2, 3000 ether);

        vm.prank(operator);
        vm.expectRevert(Executor.Unauthorized.selector);
        executor.run(
            address(weth),
            amountIn,
            0,
            _route(_v3Hop(address(evil), address(weth), address(tka)), _v2Hop(pool2, address(tka), address(weth)))
        );
        assertEq(weth.balanceOf(address(executor)), 50 ether);
    }

    function test_unlockCallbackRejectsStrangers() public {
        bytes memory data =
            abi.encode(_v4Hop(_key(address(weth), address(tka), address(0)), address(weth), address(tka), 0), 1 ether);
        vm.prank(attacker);
        vm.expectRevert(Executor.Unauthorized.selector);
        executor.unlockCallback(data);
        // Even the PoolManager is refused unless the executor itself is mid-run.
        vm.prank(manager);
        vm.expectRevert(Executor.Unauthorized.selector);
        executor.unlockCallback(data);
    }

    // ---------------------------------------------------------------- route validation

    function _expectBadRoute(Executor ex, address token, Executor.Hop[] memory hops) internal {
        vm.prank(operator);
        vm.expectRevert(Executor.BadRoute.selector);
        ex.run(token, 1 ether, 0, hops);
    }

    function test_routeValidation() public {
        address pool2 = _v2Pool(tka, 3_300_000 ether, address(weth), 1000 ether);
        address pool3 = _v3Pool(address(weth), address(tka), TICK_2992, LIQUIDITY, WIDTH);
        Executor.Hop memory wethToTka = _v2Hop(pool2, address(weth), address(tka));
        Executor.Hop memory tkaToWeth = _v3Hop(pool3, address(tka), address(weth));

        // Token discontinuity between hops.
        Executor.Hop memory tkbToWeth = _v3Hop(pool3, address(tkb), address(weth));
        _expectBadRoute(executor, address(weth), _route(wethToTka, tkbToWeth));
        // Route does not start in `token`.
        _expectBadRoute(executor, address(tka), _route(wethToTka, tkaToWeth));
        // Route does not end in `token`.
        Executor.Hop memory tkaToTkb = _v3Hop(pool3, address(tka), address(tkb));
        _expectBadRoute(executor, address(weth), _route(wethToTka, tkaToTkb));
        // Unknown hop kind.
        Executor.Hop memory unknown = _v3Hop(pool3, address(tka), address(weth));
        unknown.kind = 3;
        _expectBadRoute(executor, address(weth), _route(wethToTka, unknown));

        // A native-ETH V4 leg must name WETH as the token it carries.
        IPoolManagerHelper.PoolKey memory nativeKey = _key(address(0), address(tka), address(0));
        Executor.Hop memory nativeOut = _v4Hop(nativeKey, address(tka), address(weth), 2);
        nativeOut.tokenOut = address(tkb);
        _expectBadRoute(executor, address(tkb), _route(_v3Hop(pool3, address(tkb), address(tka)), nativeOut));

        // V4 hops are disabled when no PoolManager is configured.
        Executor noV4 = new Executor(owner, operator, address(0), address(weth));
        IPoolManagerHelper.PoolKey memory key = _key(address(weth), address(tka), address(0));
        _expectBadRoute(noV4, address(weth), _route(wethToTka, _v4Hop(key, address(tka), address(weth), 0)));

        // The well-formed route goes through (sanity check that the cases above failed for the right reason).
        vm.prank(operator);
        executor.run(address(weth), 1 ether, 0, _route(wethToTka, tkaToWeth));
    }

    // ---------------------------------------------------------------- leaked operator key

    function test_leakedOperatorKeyCannotDrainThroughFakeV3Pools() public {
        // Pool A takes the WETH and claims to pay TKA; pool B never calls back and claims to pay the WETH back.
        EvilV3Pool a = new EvilV3Pool();
        EvilV3Pool b = new EvilV3Pool();
        uint256 amountIn = 50 ether;
        a.configure(int256(amountIn), 1, int256(amountIn));
        b.configure(0, 0, int256(amountIn));

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Executor.NotProfitable.selector, 50 ether, 0));
        executor.run(
            address(weth),
            amountIn,
            0,
            _route(_v3Hop(address(a), address(weth), address(tka)), _v3Hop(address(b), address(tka), address(weth)))
        );
        assertEq(weth.balanceOf(address(executor)), 50 ether);
        assertEq(weth.balanceOf(address(a)), 0);
    }

    function test_leakedOperatorKeyCannotDrainThroughFakeV4Hooks() public {
        // Liquidity elsewhere in the PoolManager gives the hook WETH to take.
        _v4Pool(address(weth), address(tka), TICK_2992, LIQUIDITY);
        address pool2 = _v2Pool(tka, 3_000_000 ether, address(weth), 1000 ether);

        // Hook permissions live in the address: BEFORE_SWAP (1 << 7) | BEFORE_SWAP_RETURNS_DELTA (1 << 3).
        address hook = address(uint160(0xBAD) << 144 | 0x88);
        vm.etch(hook, address(new StealingHook(manager, attacker)).code);
        IPoolManagerHelper.PoolKey memory key = _key(address(weth), address(tka), hook);
        IPoolManagerInit(manager).initialize(key, TickMath.getSqrtPriceAtTick(0));

        vm.prank(operator);
        // The hook takes the 50 WETH and the executor receives nothing, so the next leg has nothing to sell.
        vm.expectRevert(bytes("INSUFFICIENT_OUTPUT_AMOUNT"));
        executor.run(
            address(weth),
            50 ether,
            0,
            _route(_v4Hop(key, address(weth), address(tka), 0), _v2Hop(pool2, address(tka), address(weth)))
        );
        assertEq(weth.balanceOf(address(executor)), 50 ether);
        assertEq(weth.balanceOf(attacker), 0);
    }

    /// @dev With a worthless start token the start-token check passes trivially; the executor's WETH is an
    ///      intermediate that a fake pool claims to have paid and a second fake pool collects.
    function test_leakedOperatorKeyCannotDrainIntermediateWeth() public {
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        EvilV3Pool claim = new EvilV3Pool();
        EvilV3Pool sink = new EvilV3Pool();
        claim.configure(0, 0, 50 ether); // never calls back, "pays" 50 WETH
        sink.configure(50 ether, 1, 0); // asks for the 50 WETH, pays nothing

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Executor.NotProfitable.selector, 50 ether, 0));
        executor.run(
            address(junk),
            1,
            0,
            _route(
                _v3Hop(address(claim), address(junk), address(weth)),
                _v3Hop(address(sink), address(weth), address(junk))
            )
        );
        assertEq(weth.balanceOf(address(executor)), 50 ether);
        assertEq(weth.balanceOf(address(sink)), 0);
    }

    /// @dev Same idea through a real V4 pool: the executor's WETH is sold for TKA, which a fake pool collects.
    function test_leakedOperatorKeyCannotDrainIntermediateWethThroughV4() public {
        IPoolManagerHelper.PoolKey memory key = _v4Pool(address(weth), address(tka), TICK_2992, LIQUIDITY);
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        EvilV3Pool claim = new EvilV3Pool();
        EvilV3Pool sink = new EvilV3Pool();
        claim.configure(0, 0, 10 ether);
        uint256 snap = vm.snapshotState();
        uint256 tkaOut = v4.swapExactIn(key, address(weth) < address(tka), 10 ether, address(this));
        vm.revertToState(snap);
        // forge-lint: disable-next-line(unsafe-typecast)
        sink.configure(int256(tkaOut), 1, 0);

        Executor.Hop[] memory hops = new Executor.Hop[](3);
        hops[0] = _v3Hop(address(claim), address(junk), address(weth));
        hops[1] = _v4Hop(key, address(weth), address(tka), 0);
        hops[2] = _v3Hop(address(sink), address(tka), address(junk));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Executor.NotProfitable.selector, 50 ether, 40 ether));
        executor.run(address(junk), 1, 0, hops);
        assertEq(weth.balanceOf(address(executor)), 50 ether);
        assertEq(tka.balanceOf(address(sink)), 0);
    }

    /// @dev Raw ETH held by the executor is never spent: native V4 input is only ever unwrapped WETH.
    function test_leakedOperatorKeyCannotSpendRawEth() public {
        IPoolManagerHelper.PoolKey memory key = _v4Pool(address(0), address(tka), TICK_2992, LIQUIDITY);
        address pool2 = _v2Pool(tka, 2_700_000 ether, address(weth), 1000 ether);
        vm.prank(owner);
        executor.withdraw(address(weth), owner, 50 ether);
        vm.deal(address(executor), 10 ether);

        vm.prank(operator);
        vm.expectRevert(bytes("")); // WETH9.withdraw: insufficient WETH
        executor.run(
            address(weth),
            1 ether,
            0,
            _route(_v4Hop(key, address(weth), address(tka), 1), _v2Hop(pool2, address(tka), address(weth)))
        );
        assertEq(address(executor).balance, 10 ether);
    }

    /// @dev A pool reporting a positive delta for the token it pays out must not become a ~2^256 hop amount.
    function test_v3PositiveOutputDeltaIsRejected() public {
        EvilV3Pool evil = new EvilV3Pool();
        address pool2 = _v2Pool(tka, 2_700_000 ether, address(weth), 1000 ether);
        evil.configure(1 ether, 1, -1);

        vm.prank(operator);
        vm.expectRevert(Executor.BadRoute.selector);
        executor.run(
            address(weth),
            1 ether,
            0,
            _route(_v3Hop(address(evil), address(weth), address(tka)), _v2Hop(pool2, address(tka), address(weth)))
        );
    }

    /// @dev Amounts above int256 max would flip into an exact-output swap (V3) or overflow the negation (V4).
    function test_hopAmountAboveInt256MaxIsRejected() public {
        address pool3 = _v3Pool(address(weth), address(tka), TICK_2992, LIQUIDITY, WIDTH);
        IPoolManagerHelper.PoolKey memory key = _v4Pool(address(weth), address(tka), TICK_2992, LIQUIDITY);
        address pool2 = _v2Pool(tka, 2_700_000 ether, address(weth), 1000 ether);
        Executor.Hop memory back = _v2Hop(pool2, address(tka), address(weth));
        uint256 tooMuch = uint256(type(int256).max) + 1;

        vm.prank(operator);
        vm.expectRevert(Executor.BadRoute.selector);
        executor.run(address(weth), tooMuch, 0, _route(_v3Hop(pool3, address(weth), address(tka)), back));
        vm.prank(operator);
        vm.expectRevert(Executor.BadRoute.selector);
        executor.run(address(weth), tooMuch, 0, _route(_v4Hop(key, address(weth), address(tka), 0), back));
    }

    /// @dev An earlier hop's pool cannot collect during a later hop.
    function test_v3CallbackRejectsOtherHopsPool() public {
        EvilV3Pool first = new EvilV3Pool();
        first.configure(1 ether, 1, 3000 ether);
        CrossHopV3Pool second = new CrossHopV3Pool(first);
        tka.mint(address(executor), 3000 ether); // so the second hop has something worth stealing

        vm.prank(operator);
        vm.expectRevert(Executor.Unauthorized.selector);
        executor.run(
            address(weth),
            1 ether,
            0,
            _route(
                _v3Hop(address(first), address(weth), address(tka)),
                _v3Hop(address(second), address(tka), address(weth))
            )
        );
    }

    /// @dev The PancakeSwap V3 callback name pays exactly like the Uniswap one.
    function test_pancakeV3CallbackPaysThePool() public {
        PancakeStylePool pancake = new PancakeStylePool(address(weth), address(tka), 3000);
        tka.mint(address(pancake), 1_000_000 ether);
        address pool2 = _v2Pool(tka, 2_700_000 ether, address(weth), 1000 ether);
        uint256 amountIn = 2 ether;
        uint256 out = _v2Out(pool2, address(tka), address(weth), amountIn * 3000);

        uint256 before = weth.balanceOf(address(executor));
        uint256 profit = _run(
            amountIn,
            _route(_v3Hop(address(pancake), address(weth), address(tka)), _v2Hop(pool2, address(tka), address(weth)))
        );
        assertEq(profit, out - amountIn);
        assertEq(weth.balanceOf(address(pancake)), amountIn, "paid through pancakeV3SwapCallback");
        _assertClean(before, profit);
    }

    /// @dev A hook re-entering the executor mid-swap is refused on every callback, and the run still lands.
    function test_v4HookCannotReenterExecutor() public {
        // Hook permissions live in the address: BEFORE_SWAP (1 << 7) only.
        address hook = address(uint160(0xBEEF) << 144 | 0x80);
        vm.etch(hook, address(new ReentrantHook(address(executor))).code);
        IPoolManagerHelper.PoolKey memory key = _key(address(weth), address(tka), hook);
        int24 tick = address(weth) < address(tka) ? TICK_2992 : -TICK_2992;
        IPoolManagerInit(manager).initialize(key, TickMath.getSqrtPriceAtTick(tick));
        // forge-lint: disable-next-line(unsafe-typecast)
        v4.modifyLiquidity(key, tick - WIDTH, tick + WIDTH, int256(uint256(LIQUIDITY)));
        address pool2 = _v2Pool(tka, 2_700_000 ether, address(weth), 1000 ether);
        uint256 amountIn = 2 ether;

        uint256 snap = vm.snapshotState();
        uint256 mid = v4.swapExactIn(key, address(weth) < address(tka), amountIn, address(this));
        uint256 out = _v2Out(pool2, address(tka), address(weth), mid);
        vm.revertToState(snap);

        uint256 before = weth.balanceOf(address(executor));
        uint256 profit = _run(
            amountIn, _route(_v4Hop(key, address(weth), address(tka), 0), _v2Hop(pool2, address(tka), address(weth)))
        );
        assertEq(profit, out - amountIn);
        _assertClean(before, profit);
        assertEq(ReentrantHook(hook).unlockCallbackError(), Executor.Unauthorized.selector);
        assertEq(ReentrantHook(hook).v3CallbackError(), Executor.Unauthorized.selector);
        assertEq(ReentrantHook(hook).pancakeCallbackError(), Executor.Unauthorized.selector);
    }

    /// @dev A native-input V4 hop that runs out of liquidity pays (and unwraps) only what the pool used; the
    ///      rest stays as WETH and the profit is the real balance change.
    function test_v4NativeInputPartialFill() public {
        IPoolManagerHelper.PoolKey memory key = _v4Pool(address(0), address(tka), TICK_2992, 1e20);
        address pool2 = _v2Pool(tka, 1_500_000 ether, address(weth), 1000 ether);
        uint256 amountIn = 2 ether;

        uint256 snap = vm.snapshotState();
        uint256 ethBefore = address(v4).balance;
        uint256 mid = v4.swapExactIn(key, true, amountIn, address(this));
        uint256 spent = ethBefore - address(v4).balance;
        uint256 out = _v2Out(pool2, address(tka), address(weth), mid);
        vm.revertToState(snap);
        assertLt(spent, amountIn, "the pool ran out of liquidity");
        assertGt(out, spent);

        uint256 wethEthBefore = address(weth).balance;
        uint256 before = weth.balanceOf(address(executor));
        uint256 profit = _run(
            amountIn, _route(_v4Hop(key, address(weth), address(tka), 1), _v2Hop(pool2, address(tka), address(weth)))
        );
        assertEq(profit, out - spent);
        _assertClean(before, profit);
        assertEq(address(weth).balance, wethEthBefore - spent, "only the used input was unwrapped");
    }

    // ---------------------------------------------------------------- fuzz

    struct FuzzCase {
        address pool2;
        address pool3;
        uint256 amountIn;
        bool v3First;
    }

    /// @dev For random V3 liquidity/price/range, V2 reserves and amounts, the executor's profit equals the
    ///      independently measured outcome, or the run reverts exactly when that outcome is not profitable.
    function testFuzz_v2V3ProfitMatchesMeasuredOrReverts(
        int256 tickSeed,
        uint256 liquidity,
        uint256 widthSeed,
        uint256 wethReserve,
        int256 skewSeed,
        uint256 amountIn,
        bool v3First
    ) public {
        int24 tick = int24(bound(tickSeed, -1000, 1000)) * SPACING; // WETH priced at 1/403 .. 403 TKA
        int24 width = int24(int256(bound(widthSeed, 1, 2000))) * SPACING;
        liquidity = bound(liquidity, 1e12, 1e25);

        FuzzCase memory c;
        // forge-lint: disable-next-line(unsafe-typecast)
        c.pool3 = _v3Pool(address(weth), address(tka), tick, uint128(liquidity), width);
        // The V2 price sits within ~2x of the V3 price either way, so both directions are often profitable.
        wethReserve = bound(wethReserve, 1e15, 1e24);
        uint256 sqrtP = TickMath.getSqrtPriceAtTick(tick + int24(bound(skewSeed, -7000, 7000)));
        uint256 tkaReserve = (((wethReserve * sqrtP) >> 96) * sqrtP) >> 96;
        c.pool2 = _v2Pool(tka, tkaReserve + 1, address(weth), wethReserve);
        c.amountIn = bound(amountIn, 1e6, 50 ether);
        c.v3First = v3First;

        (bool ok, int256 expected) = _measure(c);
        Executor.Hop[] memory hops = c.v3First
            ? _route(_v3Hop(c.pool3, address(weth), address(tka)), _v2Hop(c.pool2, address(tka), address(weth)))
            : _route(_v2Hop(c.pool2, address(weth), address(tka)), _v3Hop(c.pool3, address(tka), address(weth)));

        uint256 before = weth.balanceOf(address(executor));
        vm.prank(operator);
        if (!ok || expected < 1) {
            vm.expectRevert();
            executor.run(address(weth), c.amountIn, 1, hops);
        } else {
            uint256 profit = executor.run(address(weth), c.amountIn, 1, hops);
            assertEq(int256(profit), expected);
            assertEq(weth.balanceOf(address(executor)), before + profit);
        }
    }

    /// @dev Replays the route with the helpers. A V3 hop may stop at the price limit and consume less than it
    ///      was given; the unspent input stays with the executor, so a first-hop V3 partial fill is credited.
    function _measure(FuzzCase memory c) internal returns (bool ok, int256 delta) {
        uint256 snap = vm.snapshotState();
        uint256 spent = c.amountIn;
        uint256 out;
        if (c.v3First) {
            uint256 wethBefore = weth.balanceOf(address(v3));
            uint256 mid;
            try v3.swapExactIn(c.pool3, address(weth) < address(tka), c.amountIn, address(this)) returns (uint256 m) {
                mid = m;
            } catch {}
            spent = wethBefore - weth.balanceOf(address(v3));
            if (mid != 0) out = _v2Out(c.pool2, address(tka), address(weth), mid);
        } else {
            uint256 mid = _v2Out(c.pool2, address(weth), address(tka), c.amountIn);
            if (mid != 0) {
                _v2Swap(c.pool2, address(weth), address(tka), c.amountIn);
                try v3.swapExactIn(c.pool3, address(tka) < address(weth), mid, address(this)) returns (uint256 o) {
                    out = o;
                } catch {}
            }
        }
        vm.revertToState(snap);
        // A zero intermediate amount makes the next hop revert; a zero final amount is simply unprofitable.
        ok = out != 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        delta = int256(out) - int256(spent);
    }
}

interface IV3FactoryLikeView {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}
