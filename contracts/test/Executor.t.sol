// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Executor} from "../src/Executor.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockV2Factory, MockV2Pair} from "./mocks/MockV2.sol";
import {MockAeroFactory} from "./mocks/MockAerodrome.sol";

interface IReserves {
    function getReserves() external view returns (uint256, uint256, uint256);
    function token0() external view returns (address);
}

/// @dev Pretends to be a pool: reports juicy reserves, keeps whatever it is sent, never pays out.
contract FakePool {
    address public token0;
    address public token1;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves() external pure returns (uint256, uint256, uint256) {
        return (1, 1e30, 0);
    }

    function swap(uint256, uint256, address, bytes calldata) external {}
}

contract ExecutorTest is Test {
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");

    MockERC20 internal weth;
    MockERC20 internal tka;
    MockERC20 internal tkb;
    MockV2Factory internal uni; // 0.30%
    MockV2Factory internal pancake; // 0.25%
    MockAeroFactory internal aero; // per-pool fee
    Executor internal executor;

    function setUp() public {
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        tka = new MockERC20("Token A", "TKA", 18);
        tkb = new MockERC20("Token B", "TKB", 6);
        uni = new MockV2Factory(30);
        pancake = new MockV2Factory(25);
        aero = new MockAeroFactory();
        executor = new Executor(owner, operator);
        weth.mint(address(executor), 50 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _seed(address pool, MockERC20 a, uint256 amountA, MockERC20 b, uint256 amountB) internal {
        a.mint(pool, amountA);
        b.mint(pool, amountB);
        MockV2Pair(pool).sync(); // same selector on the Aerodrome mock
    }

    function _v2Pool(MockV2Factory f, MockERC20 a, uint256 amountA, MockERC20 b, uint256 amountB)
        internal
        returns (address pool)
    {
        pool = f.createPair(address(a), address(b));
        _seed(pool, a, amountA, b, amountB);
    }

    function _aeroPool(MockERC20 a, uint256 amountA, MockERC20 b, uint256 amountB, uint256 fee)
        internal
        returns (address pool)
    {
        pool = aero.createPool(address(a), address(b), false);
        aero.setCustomFee(pool, fee);
        _seed(pool, a, amountA, b, amountB);
    }

    function _hop(address pool, uint256 feeBps, address tokenIn) internal view returns (uint256) {
        bool zeroForOne = IReserves(pool).token0() == tokenIn;
        return uint256(uint160(pool)) | (feeBps << 160) | ((zeroForOne ? uint256(1) : 0) << 176);
    }

    /// @dev Off-chain reference implementation of the route math (what the bot computes).
    function _quote(uint256 amountIn, uint256[] memory hops) internal view returns (uint256 amount) {
        amount = amountIn;
        for (uint256 i; i < hops.length; ++i) {
            address pool = address(uint160(hops[i]));
            uint256 fee = (hops[i] >> 160) & 0xffff;
            bool zeroForOne = (hops[i] >> 176) & 1 == 1;
            (uint256 r0, uint256 r1,) = IReserves(pool).getReserves();
            (uint256 rIn, uint256 rOut) = zeroForOne ? (r0, r1) : (r1, r0);
            uint256 inWithFee = amount * (10_000 - fee);
            amount = (inWithFee * rOut) / (rIn * 10_000 + inWithFee);
        }
    }

    function _twoHopRoute() internal returns (uint256[] memory hops) {
        // WETH is worth 3000 TKA on "uni" but only 2700 TKA on "pancake":
        // sell WETH on uni, buy it back cheaper on pancake.
        address p1 = _v2Pool(uni, weth, 100 ether, tka, 300_000 ether);
        address p2 = _v2Pool(pancake, weth, 100 ether, tka, 270_000 ether);
        hops = new uint256[](2);
        hops[0] = _hop(p1, 30, address(weth));
        hops[1] = _hop(p2, 25, address(tka));
    }

    // ------------------------------------------------------------------ tests

    function test_twoHopArbitrageCapturesProfit() public {
        uint256[] memory hops = _twoHopRoute();
        uint256 amountIn = 2 ether;
        uint256 expected = _quote(amountIn, hops) - amountIn;
        assertGt(expected, 0);

        vm.prank(operator);
        uint256 profit = executor.run(address(weth), amountIn, expected, hops);

        assertEq(profit, expected);
        assertEq(weth.balanceOf(address(executor)), 50 ether + expected);
        assertEq(tka.balanceOf(address(executor)), 0, "no leftover intermediate tokens");
    }

    function test_threeHopThroughAerodromePool() public {
        // WETH->TKA (uni) -> TKB (aero, 0.05%) -> WETH (pancake). TKB is underpriced on aero.
        address p1 = _v2Pool(uni, weth, 100 ether, tka, 300_000 ether);
        address p2 = _aeroPool(tka, 1_000_000 ether, tkb, 1_100_000e6, 5);
        address p3 = _v2Pool(pancake, tkb, 300_000e6, weth, 100 ether);
        uint256[] memory hops = new uint256[](3);
        hops[0] = _hop(p1, 30, address(weth));
        hops[1] = _hop(p2, 5, address(tka));
        hops[2] = _hop(p3, 25, address(tkb));

        uint256 amountIn = 1 ether;
        uint256 expected = _quote(amountIn, hops) - amountIn;
        vm.prank(operator);
        uint256 profit = executor.run(address(weth), amountIn, 0, hops);
        assertEq(profit, expected);
        assertGt(profit, 0.05 ether);
    }

    function test_revertsWhenRouteLosesMoney() public {
        address p1 = _v2Pool(uni, weth, 100 ether, tka, 300_000 ether);
        address p2 = _v2Pool(pancake, weth, 100 ether, tka, 300_000 ether);
        uint256[] memory hops = new uint256[](2);
        hops[0] = _hop(p1, 30, address(weth));
        hops[1] = _hop(p2, 25, address(tka));

        vm.prank(operator);
        vm.expectPartialRevert(Executor.NotProfitable.selector);
        executor.run(address(weth), 1 ether, 0, hops);
        assertEq(weth.balanceOf(address(executor)), 50 ether);
    }

    function test_revertsWhenMinProfitNotMet() public {
        uint256[] memory hops = _twoHopRoute();
        uint256 expected = _quote(2 ether, hops) - 2 ether;

        vm.prank(operator);
        vm.expectPartialRevert(Executor.NotProfitable.selector);
        executor.run(address(weth), 2 ether, expected + 1, hops);
    }

    function test_absorbsStateChangeSinceSimulation() public {
        uint256[] memory hops = _twoHopRoute();
        uint256 quotedBefore = _quote(2 ether, hops);

        // Someone else trades on the first pool after the bot simulated, shrinking the gap.
        address p1 = address(uint160(hops[0]));
        weth.mint(p1, 1 ether);
        (uint256 r0, uint256 r1,) = IReserves(p1).getReserves();
        bool wethIs0 = MockV2Pair(p1).token0() == address(weth);
        uint256 out = (1 ether * 9970 * (wethIs0 ? r1 : r0)) / ((wethIs0 ? r0 : r1) * 10_000 + 1 ether * 9970);
        if (wethIs0) MockV2Pair(p1).swap(0, out, address(this), "");
        else MockV2Pair(p1).swap(out, 0, address(this), "");

        uint256 quotedAfter = _quote(2 ether, hops);
        assertLt(quotedAfter, quotedBefore);

        // The swap amounts are recomputed from live reserves, so the trade still lands (smaller profit).
        vm.prank(operator);
        uint256 profit = executor.run(address(weth), 2 ether, 0, hops);
        assertEq(profit, quotedAfter - 2 ether);
    }

    function test_onlyOperatorCanRun() public {
        uint256[] memory hops = _twoHopRoute();
        vm.expectRevert(Executor.NotOperator.selector);
        executor.run(address(weth), 1 ether, 0, hops);
        vm.prank(owner);
        vm.expectRevert(Executor.NotOperator.selector);
        executor.run(address(weth), 1 ether, 0, hops);
    }

    function test_rejectsSingleHopRoute() public {
        uint256[] memory hops = new uint256[](1);
        vm.prank(operator);
        vm.expectRevert(Executor.BadRoute.selector);
        executor.run(address(weth), 1 ether, 0, hops);
    }

    function test_leakedOperatorKeyCannotDrainInventory() public {
        // A compromised operator routes all inventory into a pool it controls.
        FakePool fake = new FakePool(address(weth), address(tka));
        address real = _v2Pool(uni, weth, 100 ether, tka, 300_000 ether);
        uint256[] memory hops = new uint256[](2);
        hops[0] = uint256(uint160(address(fake))) | (uint256(1) << 176);
        hops[1] = _hop(real, 30, address(tka));

        vm.prank(operator);
        vm.expectRevert();
        executor.run(address(weth), 50 ether, 0, hops);
        assertEq(weth.balanceOf(address(executor)), 50 ether);
        assertEq(weth.balanceOf(address(fake)), 0);
    }

    function test_ownerAdmin() public {
        address payable sink = payable(makeAddr("sink"));

        vm.expectRevert(Executor.NotOwner.selector);
        executor.withdraw(address(weth), sink, 1 ether);
        vm.prank(operator);
        vm.expectRevert(Executor.NotOwner.selector);
        executor.withdraw(address(weth), sink, 1 ether);

        vm.prank(owner);
        executor.withdraw(address(weth), sink, 10 ether);
        assertEq(weth.balanceOf(sink), 10 ether);

        vm.deal(address(executor), 1 ether);
        vm.prank(owner);
        executor.withdrawETH(sink, 1 ether);
        assertEq(sink.balance, 1 ether);

        address newOperator = makeAddr("newOperator");
        vm.prank(owner);
        executor.setOperator(newOperator);
        assertEq(executor.operator(), newOperator);

        vm.prank(owner);
        executor.transferOwnership(sink);
        assertEq(executor.owner(), sink);
        vm.prank(owner);
        vm.expectRevert(Executor.NotOwner.selector);
        executor.setOperator(owner);
    }

    /// @dev For random pool states the executor either returns exactly the off-chain quote or reverts.
    function testFuzz_profitMatchesQuoteOrReverts(
        uint256 wethA,
        uint256 tkaA,
        uint256 wethB,
        uint256 tkaB,
        uint256 amountIn,
        bool viaAero
    ) public {
        wethA = bound(wethA, 1e15, 1e27);
        wethB = bound(wethB, 1e15, 1e27);
        tkaA = bound(tkaA, 1e15, 1e30);
        tkaB = bound(tkaB, 1e15, 1e30);
        amountIn = bound(amountIn, 1e6, 50 ether);

        address p1 = _v2Pool(uni, weth, wethA, tka, tkaA);
        address p2;
        uint256 fee2;
        if (viaAero) {
            fee2 = 5;
            p2 = _aeroPool(weth, wethB, tka, tkaB, fee2);
        } else {
            fee2 = 25;
            p2 = _v2Pool(pancake, weth, wethB, tka, tkaB);
        }
        uint256[] memory hops = new uint256[](2);
        hops[0] = _hop(p1, 30, address(weth));
        hops[1] = _hop(p2, fee2, address(tka));

        uint256 mid = _quote(amountIn, _slice(hops));
        uint256 out = _quote(amountIn, hops);

        vm.prank(operator);
        if (mid == 0 || out == 0 || out <= amountIn) {
            vm.expectRevert();
            executor.run(address(weth), amountIn, 1, hops);
        } else {
            uint256 profit = executor.run(address(weth), amountIn, 1, hops);
            assertEq(profit, out - amountIn);
        }
    }

    function _slice(uint256[] memory hops) private pure returns (uint256[] memory first) {
        first = new uint256[](1);
        first[0] = hops[0];
    }
}
