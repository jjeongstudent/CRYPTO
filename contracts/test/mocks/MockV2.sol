// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @dev Port of UniswapV2Pair's swap/sync logic with a configurable fee (bps instead of the
///      hardcoded 3/1000), so the same mock can stand in for Uniswap, Sushi, Pancake-style forks.
contract MockV2Pair {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable feeBps;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    uint256 private unlocked = 1;

    event Sync(uint112 reserve0, uint112 reserve1);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );

    modifier lock() {
        require(unlocked == 1, "LOCKED");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor(address token0_, address token1_, uint256 feeBps_) {
        factory = msg.sender;
        token0 = token0_;
        token1 = token1_;
        feeBps = feeBps_;
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function sync() external lock {
        _update(IERC20Like(token0).balanceOf(address(this)), IERC20Like(token1).balanceOf(address(this)));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        require(amount0Out < _reserve0 && amount1Out < _reserve1, "INSUFFICIENT_LIQUIDITY");

        uint256 balance0;
        uint256 balance1;
        {
            require(to != token0 && to != token1, "INVALID_TO");
            if (amount0Out > 0) IERC20Like(token0).transfer(to, amount0Out);
            if (amount1Out > 0) IERC20Like(token1).transfer(to, amount1Out);
            require(data.length == 0, "NO_FLASH_IN_MOCK");
            balance0 = IERC20Like(token0).balanceOf(address(this));
            balance1 = IERC20Like(token1).balanceOf(address(this));
        }
        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "INSUFFICIENT_INPUT_AMOUNT");
        {
            uint256 balance0Adjusted = balance0 * 10_000 - amount0In * feeBps;
            uint256 balance1Adjusted = balance1 * 10_000 - amount1In * feeBps;
            require(
                balance0Adjusted * balance1Adjusted >= uint256(_reserve0) * uint256(_reserve1) * 10_000 ** 2, "K"
            );
        }
        _update(balance0, balance1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    function _update(uint256 balance0, uint256 balance1) private {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "OVERFLOW");
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }
}

contract MockV2Factory {
    uint256 public immutable feeBps;
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    constructor(uint256 feeBps_) {
        feeBps = feeBps_;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(getPair[token0][token1] == address(0), "PAIR_EXISTS");
        pair = address(new MockV2Pair(token0, token1, feeBps));
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
    }
}
