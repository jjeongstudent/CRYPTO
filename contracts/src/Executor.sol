// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @dev Uniswap V2 pairs and Aerodrome volatile pools share this swap signature.
interface IPairMinimal {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @title Executor
/// @notice Runs an atomic cyclic arbitrage across constant-product (x*y=k) pools and reverts
///         unless the contract ends up holding more of the start token than it began with.
///
/// Safety properties:
///   - Only `operator` (the bot's hot key) can call `run`.
///   - `run` never grants approvals and never accepts callbacks (swaps are called with empty data).
///   - The final balance check means a route can never reduce this contract's balance of `token`.
///     Even a leaked operator key cannot drain inventory through `run`; it can only waste gas.
///   - Only `owner` (keep this a cold wallet) can withdraw funds.
contract Executor {
    /// @dev Hop encoding: bits 0..159 pool address, bits 160..175 fee in bps, bit 176 zeroForOne.
    uint256 private constant FEE_SHIFT = 160;
    uint256 private constant DIR_SHIFT = 176;
    uint256 private constant FEE_DENOMINATOR = 10_000;

    address public owner;
    address public operator;

    event OwnerChanged(address indexed owner);
    event OperatorChanged(address indexed operator);

    error NotOwner();
    error NotOperator();
    error BadRoute();
    error BadReserves();
    error TransferFailed();
    error NotProfitable(uint256 balanceBefore, uint256 balanceAfter);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address operator_) {
        owner = owner_;
        operator = operator_;
        emit OwnerChanged(owner_);
        emit OperatorChanged(operator_);
    }

    /// @notice Execute a cycle that starts and ends in `token`.
    /// @param token      Start/end token (e.g. WETH). Must be held by this contract.
    /// @param amountIn   Amount of `token` sent into the first pool.
    /// @param minProfit  Revert unless the balance of `token` grows by at least this much.
    /// @param hops       Encoded hops, see the encoding note above. Output amounts are computed
    ///                   from live reserves, so small state changes since simulation are absorbed.
    /// @return profit    Increase in this contract's `token` balance.
    function run(address token, uint256 amountIn, uint256 minProfit, uint256[] calldata hops)
        external
        returns (uint256 profit)
    {
        if (msg.sender != operator) revert NotOperator();
        uint256 n = hops.length;
        if (n < 2) revert BadRoute();

        uint256 balanceBefore = IERC20Minimal(token).balanceOf(address(this));
        _safeTransfer(token, address(uint160(hops[0])), amountIn);

        uint256 amount = amountIn;
        for (uint256 i; i < n; ++i) {
            address to = i + 1 < n ? address(uint160(hops[i + 1])) : address(this);
            amount = _swap(hops[i], amount, to);
        }

        uint256 balanceAfter = IERC20Minimal(token).balanceOf(address(this));
        if (balanceAfter < balanceBefore + minProfit) revert NotProfitable(balanceBefore, balanceAfter);
        return balanceAfter - balanceBefore;
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

    receive() external payable {}

    /// @dev Swaps `amountIn` (already sitting in the pool) and sends the output to `to`.
    function _swap(uint256 hop, uint256 amountIn, address to) private returns (uint256 amountOut) {
        address pool = address(uint160(hop));
        uint256 feeBps = (hop >> FEE_SHIFT) & 0xffff;
        bool zeroForOne = (hop >> DIR_SHIFT) & 1 == 1;

        (uint256 reserve0, uint256 reserve1) = _reserves(pool);
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - feeBps);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);

        if (zeroForOne) IPairMinimal(pool).swap(0, amountOut, to, "");
        else IPairMinimal(pool).swap(amountOut, 0, to, "");
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
