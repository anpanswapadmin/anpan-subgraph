/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store } from "@graphprotocol/graph-ts";
import {
  Pair,
  Token,
  AnpansFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle,
} from "../../generated/schema";
import { Mint, Burn, Swap, Transfer, Sync } from "../../generated/templates/Pair/Pair";
import { updatePairDayData, updateTokenDayData, updateAnpansDayData, updatePairHourData } from "./dayUpdates";
import { getBnbPriceInUSD, findBnbPerToken, getTrackedVolumeUSD, getTrackedLiquidityUSD } from "./pricing";
import { convertTokenToDecimal, ADDRESS_ZERO, FACTORY_ADDRESS, ONE_BI, ZERO_BD, BI_18 } from "./utils";

function isCompleteMint(mintId: string): boolean {
  return MintEvent.load(mintId).sender !== null; // sufficient checks
}

export function handleTransfer(event: Transfer): void {
  // ignore initial transfers for first adds
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return;
  }

  let factory = AnpansFactory.load(FACTORY_ADDRESS);
  let transactionHash = event.transaction.hash.toHexString();

  let from = event.params.from;
  let to = event.params.to;

  // get pair and load contract
  let pair = Pair.load(event.address.toHexString());

  // liquidity token amount being transferred
  let value = convertTokenToDecimal(event.params.value, BI_18);

  // get or create transaction
  let transaction = Transaction.load(transactionHash);
  if (transaction === null) {
    transaction = new Transaction(transactionHash);
    transaction.blockNumber = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.burns = [];
    transaction.swaps = [];
  }

  // mints
  let mints = transaction.mints;
  if (from.toHexString() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value);
    pair.save();

    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
        event.transaction.hash.toHexString().concat("-").concat(BigInt.fromI32(mints.length).toString())
      );
      mint.transaction = transaction.id;
      mint.pair = pair.id;
      mint.to = to;
      mint.liquidity = value;
      mint.timestamp = transaction.timestamp;
      mint.transaction = transaction.id;
      mint.save();

      // update mints in transaction
      transaction.mints = mints.concat([mint.id]);

      // save entities
      transaction.save();
      factory.save();
    }
  }

  // case where direct send first on BNB withdrawals
  if (event.params.to.toHexString() == pair.id) {
    let burns = transaction.burns;
    let burn = new BurnEvent(
      event.transaction.hash.toHexString().concat("-").concat(BigInt.fromI32(burns.length).toString())
    );
    burn.transaction = transaction.id;
    burn.pair = pair.id;
    burn.liquidity = value;
    burn.timestamp = transaction.timestamp;
    burn.to = event.params.to;
    burn.sender = event.params.from;
    burn.needsComplete = true;
    burn.transaction = transaction.id;
    burn.save();

    // TODO: Consider using .concat() for handling array updates to protect
    // against unintended side effects for other code paths.
    burns.push(burn.id);
    transaction.burns = burns;
    transaction.save();
  }

  // burn
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.from.toHexString() == pair.id) {
    pair.totalSupply = pair.totalSupply.minus(value);
    pair.save();

    // this is a new instance of a logical burn
    let burns = transaction.burns;
    let burn: BurnEvent;
    if (burns.length > 0) {
      let currentBurn = BurnEvent.load(burns[burns.length - 1]);
      if (currentBurn.needsComplete) {
        burn = currentBurn as BurnEvent;
      } else {
        burn = new BurnEvent(
          event.transaction.hash.toHexString().concat("-").concat(BigInt.fromI32(burns.length).toString())
        );
        burn.transaction = transaction.id;
        burn.needsComplete = false;
        burn.pair = pair.id;
        burn.liquidity = value;
        burn.transaction = transaction.id;
        burn.timestamp = transaction.timestamp;
      }
    } else {
      burn = new BurnEvent(
        event.transaction.hash.toHexString().concat("-").concat(BigInt.fromI32(burns.length).toString())
      );
      burn.transaction = transaction.id;
      burn.needsComplete = false;
      burn.pair = pair.id;
      burn.liquidity = value;
      burn.transaction = transaction.id;
      burn.timestamp = transaction.timestamp;
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = MintEvent.load(mints[mints.length - 1]);
      burn.feeTo = mint.to;
      burn.feeLiquidity = mint.liquidity;
      // remove the logical mint
      store.remove("Mint", mints[mints.length - 1]);
      // update the transaction

      // TODO: Consider using .slice().pop() to protect against unintended
      // side effects for other code paths.
      mints.pop();
      transaction.mints = mints;
      transaction.save();
    }
    burn.save();
    // if accessing last one, replace it
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id;
    }
    // else add new one
    else {
      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id);
    }
    transaction.burns = burns;
    transaction.save();
  }

  transaction.save();
}

export function handleSync(event: Sync): void {
  let pair = Pair.load(event.address.toHex());
  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  let anpans = AnpansFactory.load(FACTORY_ADDRESS);

  // reset factory liquidity by subtracting onluy tarcked liquidity
  anpans.totalLiquidityBNB = anpans.totalLiquidityBNB.minus(pair.trackedReserveBNB as BigDecimal);

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1);

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals);
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals);

  if (pair.reserve1.notEqual(ZERO_BD)) pair.token0Price = pair.reserve0.div(pair.reserve1);
  else pair.token0Price = ZERO_BD;
  if (pair.reserve0.notEqual(ZERO_BD)) pair.token1Price = pair.reserve1.div(pair.reserve0);
  else pair.token1Price = ZERO_BD;

  pair.save();

  // update BNB price now that reserves could have changed
  let bundle = Bundle.load("1");
  bundle.bnbPrice = getBnbPriceInUSD();
  bundle.save();

  token0.derivedBNB = findBnbPerToken(token0 as Token);
  token1.derivedBNB = findBnbPerToken(token1 as Token);
  token0.save();
  token1.save();

  // get tracked liquidity - will be 0 if neither is in whitelist
  let trackedLiquidityBNB: BigDecimal;
  if (bundle.bnbPrice.notEqual(ZERO_BD)) {
    trackedLiquidityBNB = getTrackedLiquidityUSD(
      bundle as Bundle,
      pair.reserve0,
      token0 as Token,
      pair.reserve1,
      token1 as Token
    ).div(bundle.bnbPrice);
  } else {
    trackedLiquidityBNB = ZERO_BD;
  }

  // use derived amounts within pair
  pair.trackedReserveBNB = trackedLiquidityBNB;
  pair.reserveBNB = pair.reserve0
    .times(token0.derivedBNB as BigDecimal)
    .plus(pair.reserve1.times(token1.derivedBNB as BigDecimal));
  pair.reserveUSD = pair.reserveBNB.times(bundle.bnbPrice);

  // use tracked amounts globally
  anpans.totalLiquidityBNB = anpans.totalLiquidityBNB.plus(trackedLiquidityBNB);
  anpans.totalLiquidityUSD = anpans.totalLiquidityBNB.times(bundle.bnbPrice);

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1);

  // save entities
  pair.save();
  anpans.save();
  token0.save();
  token1.save();
}

export function handleMint(event: Mint): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString());
  let mints = transaction.mints;
  let mint = MintEvent.load(mints[mints.length - 1]);

  let pair = Pair.load(event.address.toHex());
  let anpans = AnpansFactory.load(FACTORY_ADDRESS);

  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);

  // update exchange info (except balances, sync will cover that)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals);
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI);
  token1.txCount = token1.txCount.plus(ONE_BI);

  // get new amounts of USD and BNB for tracking
  let bundle = Bundle.load("1");
  let amountTotalUSD = token1.derivedBNB
    .times(token1Amount)
    .plus(token0.derivedBNB.times(token0Amount))
    .times(bundle.bnbPrice);

  // update txn counts
  pair.txCount = pair.txCount.plus(ONE_BI);
  anpans.txCount = anpans.txCount.plus(ONE_BI);

  // save entities
  token0.save();
  token1.save();
  pair.save();
  anpans.save();

  mint.sender = event.params.sender;
  mint.amount0 = token0Amount as BigDecimal;
  mint.amount1 = token1Amount as BigDecimal;
  mint.logIndex = event.logIndex;
  mint.amountUSD = amountTotalUSD as BigDecimal;
  mint.save();

  // update day entities
  updatePairDayData(event);
  updatePairHourData(event);
  updateAnpansDayData(event);
  updateTokenDayData(token0 as Token, event);
  updateTokenDayData(token1 as Token, event);
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString());

  // safety check
  if (transaction === null) {
    return;
  }

  let burns = transaction.burns;
  let burn = BurnEvent.load(burns[burns.length - 1]);

  let pair = Pair.load(event.address.toHex());
  let anpans = AnpansFactory.load(FACTORY_ADDRESS);

  //update token info
  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals);
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI);
  token1.txCount = token1.txCount.plus(ONE_BI);

  // get new amounts of USD and BNB for tracking
  let bundle = Bundle.load("1");
  let amountTotalUSD = token1.derivedBNB
    .times(token1Amount)
    .plus(token0.derivedBNB.times(token0Amount))
    .times(bundle.bnbPrice);

  // update txn counts
  anpans.txCount = anpans.txCount.plus(ONE_BI);
  pair.txCount = pair.txCount.plus(ONE_BI);

  // update global counter and save
  token0.save();
  token1.save();
  pair.save();
  anpans.save();

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal;
  burn.amount1 = token1Amount as BigDecimal;
  // burn.to = event.params.to
  burn.logIndex = event.logIndex;
  burn.amountUSD = amountTotalUSD as BigDecimal;
  burn.save();

  // update day entities
  updatePairDayData(event);
  updatePairHourData(event);
  updateAnpansDayData(event);
  updateTokenDayData(token0 as Token, event);
  updateTokenDayData(token1 as Token, event);
}

export function handleSwap(event: Swap): void {
  let pair = Pair.load(event.address.toHexString());
  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals);
  let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals);
  let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals);
  let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals);

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In);
  let amount1Total = amount1Out.plus(amount1In);

  // BNB/USD prices
  let bundle = Bundle.load("1");

  // get total amounts of derived USD and BNB for tracking
  let derivedAmountBNB = token1.derivedBNB
    .times(amount1Total)
    .plus(token0.derivedBNB.times(amount0Total))
    .div(BigDecimal.fromString("2"));
  let derivedAmountUSD = derivedAmountBNB.times(bundle.bnbPrice);

  // only accounts for volume through white listed tokens
  let trackedAmountUSD = getTrackedVolumeUSD(
    bundle as Bundle,
    amount0Total,
    token0 as Token,
    amount1Total,
    token1 as Token
  );

  let trackedAmountBNB: BigDecimal;
  if (bundle.bnbPrice.equals(ZERO_BD)) {
    trackedAmountBNB = ZERO_BD;
  } else {
    trackedAmountBNB = trackedAmountUSD.div(bundle.bnbPrice);
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out));
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD);
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out));
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD);
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI);
  token1.txCount = token1.txCount.plus(ONE_BI);

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD);
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total);
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total);
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD);
  pair.txCount = pair.txCount.plus(ONE_BI);
  pair.save();

  // update global values, only used tracked amounts for volume
  let anpans = AnpansFactory.load(FACTORY_ADDRESS);
  anpans.totalVolumeUSD = anpans.totalVolumeUSD.plus(trackedAmountUSD);
  anpans.totalVolumeBNB = anpans.totalVolumeBNB.plus(trackedAmountBNB);
  anpans.untrackedVolumeUSD = anpans.untrackedVolumeUSD.plus(derivedAmountUSD);
  anpans.txCount = anpans.txCount.plus(ONE_BI);

  // save entities
  pair.save();
  token0.save();
  token1.save();
  anpans.save();

  let transaction = Transaction.load(event.transaction.hash.toHexString());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString());
    transaction.blockNumber = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.swaps = [];
    transaction.burns = [];
  }
  let swaps = transaction.swaps;
  let swap = new SwapEvent(
    event.transaction.hash.toHexString().concat("-").concat(BigInt.fromI32(swaps.length).toString())
  );

  // update swap event
  swap.transaction = transaction.id;
  swap.pair = pair.id;
  swap.timestamp = transaction.timestamp;
  swap.transaction = transaction.id;
  swap.sender = event.params.sender;
  swap.amount0In = amount0In;
  swap.amount1In = amount1In;
  swap.amount0Out = amount0Out;
  swap.amount1Out = amount1Out;
  swap.to = event.params.to;
  swap.from = event.transaction.from;
  swap.logIndex = event.logIndex;
  // use the tracked amount if we have it
  swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD;
  swap.save();

  // update the transaction

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id);
  transaction.swaps = swaps;
  transaction.save();

  // update day entities
  let pairDayData = updatePairDayData(event);
  let pairHourData = updatePairHourData(event);
  let anpansDayData = updateAnpansDayData(event);
  let token0DayData = updateTokenDayData(token0 as Token, event);
  let token1DayData = updateTokenDayData(token1 as Token, event);

  // swap specific updating
  anpansDayData.dailyVolumeUSD = anpansDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  anpansDayData.dailyVolumeBNB = anpansDayData.dailyVolumeBNB.plus(trackedAmountBNB);
  anpansDayData.dailyVolumeUntracked = anpansDayData.dailyVolumeUntracked.plus(derivedAmountUSD);
  anpansDayData.save();

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total);
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total);
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  pairDayData.save();

  // update hourly pair data
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total);
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total);
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD);
  pairHourData.save();

  // swap specific updating for token0
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total);
  token0DayData.dailyVolumeBNB = token0DayData.dailyVolumeBNB.plus(amount0Total.times(token1.derivedBNB as BigDecimal));
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total.times(token0.derivedBNB as BigDecimal).times(bundle.bnbPrice)
  );
  token0DayData.save();

  // swap specific updating
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total);
  token1DayData.dailyVolumeBNB = token1DayData.dailyVolumeBNB.plus(amount1Total.times(token1.derivedBNB as BigDecimal));
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total.times(token1.derivedBNB as BigDecimal).times(bundle.bnbPrice)
  );
  token1DayData.save();
}