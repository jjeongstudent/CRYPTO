// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @dev Uniswap V2 pairs and Aerodrome volatile pools share this swap signature.
interface IPairMinimal {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @dev Uniswap V3 and its forks (Aerodrome Slipstream, PancakeSwap V3, SushiSwap V3) share this signature.
interface IV3PoolMinimal {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IPoolManagerMinimal {
    /// @dev Uniswap V4 PoolKey with the user-defined value types (Currency, IHooks) spelled as addresses.
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified; // negative = exact input
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    /// @dev Returns a BalanceDelta: amount0 in the high 128 bits, amount1 in the low 128 bits.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/// @title Executor
/// @notice Runs an atomic cyclic arbitrage across V2-style pairs, V3-style pools and Uniswap V4 pools and
///         reverts unless the contract ends up holding more of the start token than it began with.
///
/// Safety properties:
///   - Only `operator` (the bot's hot key) can call `run`.
///   - `run` never grants approvals. Every hop pays from this contract's own balance.
///   - Callbacks are only honoured from the V3 pool / V4 PoolManager the current hop is calling, and a V3
///     callback can pay at most once and at most the amount routed into that hop.
///   - The final balance check means a route can never reduce this contract's balance of `token`.
///     Even a leaked operator key cannot drain inventory through `run`; it can only waste gas.
///   - Only `owner` (keep this a cold wallet) can withdraw funds.
contract Executor {
    struct Hop {
        uint8 kind; // 0 = V2-style pair, 1 = V3-style pool, 2 = Uniswap V4 pool
        address pool; // kind 0/1: pair/pool address. kind 2: the PoolKey's hooks address
        address tokenIn; // ERC20 sold (WETH when the V4 input currency is native ETH)
        address tokenOut; // ERC20 bought (WETH when the V4 output currency is native ETH)
        uint24 fee; // kind 0: fee in bps; kind 1: ignored; kind 2: PoolKey.fee (raw)
        int24 tickSpacing; // kind 2 only
        bool zeroForOne; // direction relative to the pool's token0/token1 (currency0/currency1)
        uint8 flags; // kind 2 only: NATIVE_IN | NATIVE_OUT
    }

    uint8 private constant KIND_V2 = 0;
    uint8 private constant KIND_V3 = 1;
    uint8 private constant KIND_V4 = 2;
    uint8 private constant NATIVE_IN = 1;
    uint8 private constant NATIVE_OUT = 2;
    uint256 private constant FEE_DENOMINATOR = 10_000;

    // TickMath bounds; the swap limits sit one inside them so a hop is never stopped by its price limit.
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address public owner;
    address public operator;
    address public immutable poolManager;
    address public immutable weth;

    // Per-hop callback authorisation. Transient, so nothing survives the transaction.
    address private transient expectedPool;
    address private transient payToken;
    uint256 private transient maxPayment;
    bool private transient active;

    event OwnerChanged(address indexed owner);
    event OperatorChanged(address indexed operator);

    error NotOwner();
    error NotOperator();
    error BadRoute();
    error BadReserves();
    error TransferFailed();
    error Unauthorized();
    error NotProfitable(uint256 balanceBefore, uint256 balanceAfter);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param poolManager_ Uniswap V4 PoolManager, or address(0) to disable V4 hops.
    constructor(address owner_, address operator_, address poolManager_, address weth_) {
        owner = owner_;
        operator = operator_;
        poolManager = poolManager_;
        weth = weth_;
        emit OwnerChanged(owner_);
        emit OperatorChanged(operator_);
    }

    /// @notice Execute a cycle that starts and ends in `token`.
    /// @param token      Start/end token (e.g. WETH). Must be held by this contract.
    /// @param amountIn   Amount of `token` sold in the first hop.
    /// @param minProfit  Revert unless the balance of `token` grows by at least this much.
    /// @param hops       The route. Each hop sells the previous hop's output; amounts are computed from live
    ///                   pool state, so small state changes since simulation are absorbed.
    /// @return profit    Increase in this contract's `token` balance.
    function run(address token, uint256 amountIn, uint256 minProfit, Hop[] calldata hops)
        external
        returns (uint256 profit)
    {
        if (msg.sender != operator) revert NotOperator();
        _validate(token, hops);

        uint256 balanceBefore = IERC20Minimal(token).balanceOf(address(this));
        active = true;
        uint256 amount = amountIn;
        for (uint256 i; i < hops.length; ++i) {
            Hop calldata hop = hops[i];
            if (hop.kind == KIND_V2) amount = _swapV2(hop, amount);
            else if (hop.kind == KIND_V3) amount = _swapV3(hop, amount);
            else amount = _swapV4(hop, amount);
        }
        active = false;

        uint256 balanceAfter = IERC20Minimal(token).balanceOf(address(this));
        if (balanceAfter < balanceBefore + minProfit) revert NotProfitable(balanceBefore, balanceAfter);
        return balanceAfter - balanceBefore;
    }

    /// @notice Uniswap V3 (and Slipstream / SushiSwap V3) swap callback.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payV3(amount0Delta, amount1Delta);
    }

    /// @notice PancakeSwap V3 names its callback differently; same contract.
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payV3(amount0Delta, amount1Delta);
    }

    /// @notice Uniswap V4 unlock callback: performs one exact-input swap and settles it.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager || !active) revert Unauthorized();
        (Hop memory hop, uint256 amount) = abi.decode(data, (Hop, uint256));

        address currencyIn = hop.flags & NATIVE_IN != 0 ? address(0) : hop.tokenIn;
        address currencyOut = hop.flags & NATIVE_OUT != 0 ? address(0) : hop.tokenOut;
        (address currency0, address currency1) = hop.zeroForOne ? (currencyIn, currencyOut) : (currencyOut, currencyIn);
        IPoolManagerMinimal.PoolKey memory key =
            IPoolManagerMinimal.PoolKey(currency0, currency1, hop.fee, hop.tickSpacing, hop.pool);
        IPoolManagerMinimal.SwapParams memory params = IPoolManagerMinimal.SwapParams(
            hop.zeroForOne,
            // forge-lint: disable-next-line(unsafe-typecast) an absurd amount just fails; the balance check holds
            -int256(amount), // negative = exact input
            hop.zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1
        );
        int256 delta = IPoolManagerMinimal(poolManager).swap(key, params, "");

        // BalanceDelta unpacking: the truncations are the point.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 delta0 = int128(delta >> 128);
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 delta1 = int128(delta);
        (int256 deltaIn, int256 deltaOut) = hop.zeroForOne ? (delta0, delta1) : (delta1, delta0);
        if (deltaIn > 0 || deltaOut < 0) revert BadRoute();
        // forge-lint: disable-next-line(unsafe-typecast) sign checked above
        uint256 pay = uint256(-deltaIn);
        // forge-lint: disable-next-line(unsafe-typecast) sign checked above
        uint256 got = uint256(deltaOut);

        if (pay != 0) {
            if (currencyIn == address(0)) {
                IWETH(weth).withdraw(pay);
                IPoolManagerMinimal(poolManager).settle{value: pay}();
            } else {
                IPoolManagerMinimal(poolManager).sync(currencyIn);
                _safeTransfer(currencyIn, poolManager, pay);
                IPoolManagerMinimal(poolManager).settle();
            }
        }
        if (got != 0) {
            IPoolManagerMinimal(poolManager).take(currencyOut, address(this), got);
            if (currencyOut == address(0)) IWETH(weth).deposit{value: got}();
        }
        return abi.encode(got);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        _safeTransfer(token, to, amount);
    }

    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function transferOwnership(address owner_) external onlyOwner {
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    /// @dev Receives ETH from WETH unwraps and from V4 `take` of native currency.
    receive() external payable {}

    function _validate(address token, Hop[] calldata hops) private view {
        uint256 n = hops.length;
        if (n < 2 || hops[0].tokenIn != token || hops[n - 1].tokenOut != token) revert BadRoute();
        for (uint256 i; i < n; ++i) {
            Hop calldata hop = hops[i];
            if (hop.kind > KIND_V4) revert BadRoute();
            if (hop.kind == KIND_V4) {
                if (poolManager == address(0)) revert BadRoute();
                // Native ETH is carried between hops as WETH.
                if (hop.flags & NATIVE_IN != 0 && hop.tokenIn != weth) revert BadRoute();
                if (hop.flags & NATIVE_OUT != 0 && hop.tokenOut != weth) revert BadRoute();
            }
            if (i + 1 < n && hop.tokenOut != hops[i + 1].tokenIn) revert BadRoute();
        }
    }

    /// @dev Sends `amountIn` to the pair and pulls the constant-product output back to this contract.
    function _swapV2(Hop calldata hop, uint256 amountIn) private returns (uint256 amountOut) {
        _safeTransfer(hop.tokenIn, hop.pool, amountIn);
        (uint256 reserve0, uint256 reserve1) = _reserves(hop.pool);
        (uint256 reserveIn, uint256 reserveOut) = hop.zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - hop.fee);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);

        if (hop.zeroForOne) IPairMinimal(hop.pool).swap(0, amountOut, address(this), "");
        else IPairMinimal(hop.pool).swap(amountOut, 0, address(this), "");
    }

    function _swapV3(Hop calldata hop, uint256 amountIn) private returns (uint256 amountOut) {
        expectedPool = hop.pool;
        payToken = hop.tokenIn;
        maxPayment = amountIn;
        // forge-lint: disable-next-line(unsafe-typecast) an absurd amount just fails; the balance check holds
        int256 amountSpecified = int256(amountIn);
        (int256 amount0, int256 amount1) = IV3PoolMinimal(hop.pool)
            .swap(
                address(this),
                hop.zeroForOne,
                amountSpecified,
                hop.zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                ""
            );
        // A pool that never called back leaves the slot set; clear it so it cannot be used later.
        expectedPool = address(0);
        amountOut = uint256(-(hop.zeroForOne ? amount1 : amount0));
    }

    function _swapV4(Hop calldata hop, uint256 amountIn) private returns (uint256 amountOut) {
        bytes memory result = IPoolManagerMinimal(poolManager).unlock(abi.encode(hop, amountIn));
        amountOut = abi.decode(result, (uint256));
    }

    function _payV3(int256 amount0Delta, int256 amount1Delta) private {
        address pool = expectedPool;
        if (pool == address(0) || msg.sender != pool) revert Unauthorized();
        uint256 pay = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        if (pay > maxPayment) revert Unauthorized();
        // One-shot: a pool that calls back again finds no authorisation.
        expectedPool = address(0);
        _safeTransfer(payToken, msg.sender, pay);
    }

    /// @dev Reads the first two words of getReserves(). Works for Uniswap V2 (uint112, uint112, uint32)
    ///      and Aerodrome (uint256, uint256, uint256) since both ABI-encode to 32-byte words.
    function _reserves(address pool) private view returns (uint256 reserve0, uint256 reserve1) {
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSelector(0x0902f1ac));
        if (!ok || data.length < 64) revert BadReserves();
        (reserve0, reserve1) = abi.decode(data, (uint256, uint256));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
