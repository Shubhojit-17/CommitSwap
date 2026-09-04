/**
 * CommitSwap — Intent Matcher Engine (Modeled after IntentMatcher.sol)
 * Two-pass greedy CoW crossing with AMM residual calculation & price scaling.
 */
import { ethers } from "ethers";

export interface IntentOrder {
  id: number;
  committer: string;
  amount: bigint;
  minAmountOut: bigint;
  zeroForOne: boolean;
  revealed: boolean;
  settled: boolean;
  bondAmount: bigint;
  windowIndex: number;
  salt: string;
  txHash?: string;
  timestamp: string;
}

export interface OrderFillOutcome {
  id: number;
  committer: string;
  direction: "ETH → USDC" | "USDC → ETH";
  tokenIn: string;
  tokenOut: string;
  originalAmount: string;
  matchedAmount: string;
  fillPercentage: number;
  residualAmount: string;
  residualAction: "100% CoW Peer-to-Peer" | "AMM Fallback Swap";
}

export interface MatchResult {
  hasMatch: boolean;
  cowMatchedVolume: bigint;
  cowMatchedVolumeEth: string;
  cowMatchedVolumeUsdc: string;
  residualZeroForOne: boolean;
  residualVolume: bigint;
  residualVolumeStr: string;
  matchedPairs: Array<{
    buyOrderId: number;
    sellOrderId: number;
    amountInEth: string;
    amountInUsdc: string;
  }>;
  orderFills: OrderFillOutcome[];
  forfeitedOrders: number[];
  keeperCutEth: bigint;
}

export class MatcherService {
  // Benchmark reference rate: 1 ETH = 2,500 USDC
  static readonly DEFAULT_PRICE18 = 2500n * 10n ** 18n;

  /**
   * Runs the CoW matching algorithm on a batch of revealed orders using price normalization.
   */
  static matchBatch(orders: IntentOrder[], price18: bigint = MatcherService.DEFAULT_PRICE18): MatchResult {
    const revealed = orders.filter(o => o.revealed && !o.settled);
    const unrevealed = orders.filter(o => !o.revealed && !o.settled);

    // Keeper payout: 5% on revealed bonds + 100% of unrevealed forfeited bonds
    const revealedBondSum = revealed.reduce((sum, o) => sum + o.bondAmount, 0n);
    const forfeitedBondSum = unrevealed.reduce((sum, o) => sum + o.bondAmount, 0n);
    const keeperCutEth = (revealedBondSum * 5n / 100n) + forfeitedBondSum;

    const group0 = revealed.filter(o => o.zeroForOne); // Selling ETH for USDC
    const group1 = revealed.filter(o => !o.zeroForOne); // Selling USDC for ETH

    // CoW match requires BOTH directions to exist
    if (group0.length === 0 || group1.length === 0) {
      const remainingVol = group0.length > 0
        ? group0.reduce((sum, o) => sum + o.amount, 0n)
        : group1.reduce((sum, o) => sum + o.amount, 0n);

      return {
        hasMatch: false,
        cowMatchedVolume: 0n,
        cowMatchedVolumeEth: "0.000",
        cowMatchedVolumeUsdc: "0.00",
        residualZeroForOne: group0.length > 0,
        residualVolume: remainingVol,
        residualVolumeStr: group0.length > 0 
          ? `${ethers.formatEther(remainingVol)} ETH`
          : `${ethers.formatEther(remainingVol)} USDC`,
        matchedPairs: [],
        orderFills: revealed.map(o => ({
          id: o.id,
          committer: o.committer,
          direction: o.zeroForOne ? "ETH → USDC" : "USDC → ETH",
          tokenIn: o.zeroForOne ? "ETH" : "USDC",
          tokenOut: o.zeroForOne ? "USDC" : "ETH",
          originalAmount: ethers.formatEther(o.amount),
          matchedAmount: "0.0",
          fillPercentage: 0,
          residualAmount: ethers.formatEther(o.amount),
          residualAction: "AMM Fallback Swap"
        })),
        forfeitedOrders: unrevealed.map(o => o.id),
        keeperCutEth
      };
    }

    // Token0 (ETH) amounts and Token1 (USDC) amounts
    // Convert ETH volume to USDC equivalent: token1 = (token0 * price18) / 1e18
    let totalEth0 = group0.reduce((sum, o) => sum + o.amount, 0n);
    let totalUsdc1 = group1.reduce((sum, o) => sum + o.amount, 0n);

    let totalEth0InUsdc = (totalEth0 * price18) / (10n ** 18n);

    // Overlapping volume in USDC terms
    const cowMatchUsdc = totalEth0InUsdc < totalUsdc1 ? totalEth0InUsdc : totalUsdc1;
    const cowMatchEth = (cowMatchUsdc * 10n ** 18n) / price18;

    const residualZeroForOne = totalEth0InUsdc > totalUsdc1;
    let residualVolumeUsdc = residualZeroForOne ? (totalEth0InUsdc - totalUsdc1) : (totalUsdc1 - totalEth0InUsdc);
    let residualVolume = residualZeroForOne 
      ? (residualVolumeUsdc * 10n ** 18n) / price18 
      : residualVolumeUsdc;

    // Build matched pairs and tracking remaining balances
    const matchedPairs: MatchResult["matchedPairs"] = [];
    const matchedAmounts: Map<number, bigint> = new Map();

    let remEth = new Map(group0.map(o => [o.id, o.amount]));
    let remUsdc = new Map(group1.map(o => [o.id, o.amount]));

    let i0 = 0, i1 = 0;
    while (i0 < group0.length && i1 < group1.length) {
      const o0 = group0[i0];
      const o1 = group1[i1];

      let r0Eth = remEth.get(o0.id) || 0n;
      let r1Usdc = remUsdc.get(o1.id) || 0n;

      // Convert r0Eth to USDC terms
      let r0UsdcEquiv = (r0Eth * price18) / (10n ** 18n);

      if (r0UsdcEquiv <= 0n || r1Usdc <= 0n) {
        if (r0UsdcEquiv <= 0n) i0++;
        if (r1Usdc <= 0n) i1++;
        continue;
      }

      // Match whichever side is smaller
      const matchUsdc = r0UsdcEquiv < r1Usdc ? r0UsdcEquiv : r1Usdc;
      const matchEth = (matchUsdc * 10n ** 18n) / price18;

      matchedPairs.push({
        buyOrderId: o0.id,
        sellOrderId: o1.id,
        amountInEth: ethers.formatEther(matchEth),
        amountInUsdc: ethers.formatEther(matchUsdc)
      });

      // Update matched tracking
      matchedAmounts.set(o0.id, (matchedAmounts.get(o0.id) || 0n) + matchEth);
      matchedAmounts.set(o1.id, (matchedAmounts.get(o1.id) || 0n) + matchUsdc);

      // Decrement remaining
      remEth.set(o0.id, r0Eth > matchEth ? r0Eth - matchEth : 0n);
      remUsdc.set(o1.id, r1Usdc > matchUsdc ? r1Usdc - matchUsdc : 0n);

      if ((remEth.get(o0.id) || 0n) === 0n) i0++;
      if ((remUsdc.get(o1.id) || 0n) === 0n) i1++;
    }

    // Build per-order fill outcomes
    const orderFills: OrderFillOutcome[] = revealed.map(o => {
      const matched = matchedAmounts.get(o.id) || 0n;
      const residual = o.amount > matched ? o.amount - matched : 0n;
      const fillPct = o.amount > 0n ? Number((matched * 10000n) / o.amount) / 100 : 0;

      return {
        id: o.id,
        committer: o.committer,
        direction: o.zeroForOne ? "ETH → USDC" : "USDC → ETH",
        tokenIn: o.zeroForOne ? "ETH" : "USDC",
        tokenOut: o.zeroForOne ? "USDC" : "ETH",
        originalAmount: ethers.formatEther(o.amount),
        matchedAmount: ethers.formatEther(matched),
        fillPercentage: fillPct,
        residualAmount: ethers.formatEther(residual),
        residualAction: residual === 0n ? "100% CoW Peer-to-Peer" : "AMM Fallback Swap"
      };
    });

    return {
      hasMatch: cowMatchEth > 0n,
      cowMatchedVolume: cowMatchEth,
      cowMatchedVolumeEth: ethers.formatEther(cowMatchEth),
      cowMatchedVolumeUsdc: ethers.formatEther(cowMatchUsdc),
      residualZeroForOne,
      residualVolume,
      residualVolumeStr: residualZeroForOne 
        ? `${ethers.formatEther(residualVolume)} ETH` 
        : `${ethers.formatEther(residualVolume)} USDC`,
      matchedPairs,
      orderFills,
      forfeitedOrders: unrevealed.map(o => o.id),
      keeperCutEth
    };
  }
}
