// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Aero {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @dev Mirrors Aerodrome's volatile Pool: uint256 reserves, Sync(uint256,uint256), per-pool fee
///      read from the factory, fees moved out of the pool before the x*y >= k check.
contract MockAeroPool {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    bool public constant stable = false;

    uint256 private reserve0;
    uint256 private reserve1;
    uint256 private blockTimestampLast;

    event Sync(uint256 reserve0, uint256 reserve1);
    event Swap(
        address indexed sender,
        address indexed to,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out
    );

    constructor(address token0_, address token1_) {
        factory = msg.sender;
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves() public view returns (uint256, uint256, uint256) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function sync() external {
        _update(IERC20Aero(token0).balanceOf(address(this)), IERC20Aero(token1).balanceOf(address(this)));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require(amount0Out > 0 || amount1Out > 0, "IOA");
        (uint256 _reserve0, uint256 _reserve1,) = getReserves();
        require(amount0Out < _reserve0 && amount1Out < _reserve1, "IL");
        require(to != token0 && to != token1, "IT");
        require(data.length == 0, "NO_HOOK_IN_MOCK");
        if (amount0Out > 0) IERC20Aero(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20Aero(token1).transfer(to, amount1Out);
        (uint256 amount0In, uint256 amount1In) = _takeFees(_reserve0 - amount0Out, _reserve1 - amount1Out);

        uint256 balance0 = IERC20Aero(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Aero(token1).balanceOf(address(this));
        require(balance0 * balance1 >= _reserve0 * _reserve1, "K");
        _update(balance0, balance1);
        emit Swap(msg.sender, to, amount0In, amount1In, amount0Out, amount1Out);
    }

    /// @dev Works out how much came in and moves the fee share out of the pool (to the factory).
    function _takeFees(uint256 untouched0, uint256 untouched1) private returns (uint256 amount0In, uint256 amount1In) {
        uint256 balance0 = IERC20Aero(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Aero(token1).balanceOf(address(this));
        amount0In = balance0 > untouched0 ? balance0 - untouched0 : 0;
        amount1In = balance1 > untouched1 ? balance1 - untouched1 : 0;
        require(amount0In > 0 || amount1In > 0, "IIA");

        uint256 fee = MockAeroFactory(factory).getFee(address(this), false);
        if (amount0In > 0) IERC20Aero(token0).transfer(factory, (amount0In * fee) / 10_000);
        if (amount1In > 0) IERC20Aero(token1).transfer(factory, (amount1In * fee) / 10_000);
    }

    function _update(uint256 balance0, uint256 balance1) private {
        reserve0 = balance0;
        reserve1 = balance1;
        blockTimestampLast = block.timestamp;
        emit Sync(balance0, balance1);
    }
}

contract MockAeroFactory {
    uint256 public volatileFee = 30;
    mapping(address => uint256) public customFee;
    mapping(address => mapping(address => mapping(bool => address))) public getPool;

    function getFee(address pool, bool) external view returns (uint256) {
        uint256 fee = customFee[pool];
        return fee != 0 ? fee : volatileFee;
    }

    function setCustomFee(address pool, uint256 fee) external {
        customFee[pool] = fee;
    }

    function createPool(address tokenA, address tokenB, bool stable_) external returns (address pool) {
        require(!stable_, "MOCK_VOLATILE_ONLY");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pool = address(new MockAeroPool(token0, token1));
        getPool[token0][token1][false] = pool;
        getPool[token1][token0][false] = pool;
    }
}
