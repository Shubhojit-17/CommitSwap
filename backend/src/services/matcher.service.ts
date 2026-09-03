/**
 * CommitSwap — Intent Matcher Engine (Modeled after IntentMatcher.sol)
 * Two-pass greedy CoW crossing with AMM residual calculation.
 */

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

export interface MatchResult {
  cowMatchedVolume: bigint;
  residualZeroForOne: boolean;
  residualVolume: bigint;
  matchedPairs: Array<{
    buyOrderId: number;
    sellOrderId: number;
    amount: bigint;
  }>;
  forfeitedOrders: number[];
  keeperCutEth: bigint;
}

export class MatcherService {
  /**
   * Runs the CoW matching algorithm on a batch of revealed orders.
   */
  static matchBatch(orders: IntentOrder[]): MatchResult {
    const revealed = orders.filter(o => o.revealed && !o.settled);
    const unrevealed = orders.filter(o => !o.revealed && !o.settled);

    const group0 = revealed.filter(o => o.zeroForOne); // Selling T0 for T1
    const group1 = revealed.filter(o => !o.zeroForOne); // Selling T1 for T0

    let totalVol0 = group0.reduce((sum, o) => sum + o.amount, 0n);
    let totalVol1 = group1.reduce((sum, o) => sum + o.amount, 0n);

    // CoW match is the overlapping volume between buyers and sellers
    const cowMatch = totalVol0 < totalVol1 ? totalVol0 : totalVol1;

    let residualZeroForOne = totalVol0 > totalVol1;
    let residualVolume = residualZeroForOne ? totalVol0 - totalVol1 : totalVol1 - totalVol0;

    // Build matched pairs preview
    const matchedPairs: MatchResult["matchedPairs"] = [];
    let i0 = 0, i1 = 0;
    let rem0 = group0[0]?.amount || 0n;
    let rem1 = group1[0]?.amount || 0n;

    while (i0 < group0.length && i1 < group1.length) {
      const matchAmt = rem0 < rem1 ? rem0 : rem1;
      if (matchAmt > 0n) {
        matchedPairs.push({
          buyOrderId: group0[i0].id,
          sellOrderId: group1[i1].id,
          amount: matchAmt
        });
        rem0 -= matchAmt;
        rem1 -= matchAmt;
      }

      if (rem0 === 0n) {
        i0++;
        rem0 = group0[i0]?.amount || 0n;
      }
      if (rem1 === 0n) {
        i1++;
        rem1 = group1[i1]?.amount || 0n;
      }
    }

    // Keeper payout calculation: 5% on revealed bonds + 100% of unrevealed forfeited bonds
    const revealedBondSum = revealed.reduce((sum, o) => sum + o.bondAmount, 0n);
    const forfeitedBondSum = unrevealed.reduce((sum, o) => sum + o.bondAmount, 0n);
    const keeperCutEth = (revealedBondSum * 5n / 100n) + forfeitedBondSum;

    return {
      cowMatchedVolume: cowMatch * 2n,
      residualZeroForOne,
      residualVolume,
      matchedPairs,
      forfeitedOrders: unrevealed.map(o => o.id),
      keeperCutEth
    };
  }
}
