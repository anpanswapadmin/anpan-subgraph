/* eslint-disable prefer-const */
import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { Pair } from "../../../generated/templates/Pair/Pair";

export let BI_ZERO = BigInt.fromI32(0);
export let BI_ONE = BigInt.fromI32(1);
export let BD_ZERO = BigDecimal.fromString("0");
export let BD_1E18 = BigDecimal.fromString("1e18");

export let TRACKED_PAIRS: string[] = [
  "0x14fA5493E17Aad701E3d59d90fB6D2814a39A176", // WBNB/BUSD
  "0x9A820014ec8ec38A3CA3fA23262eEb7079018003", // ANPAN/WBNB
  "0xED0Ed1579c8698474d45cb701E74ea212FbF4EE6", // ETH/WBNB
  "0xfe1f25F2044a798f66187f2f6C5Fd11136dCbB3A", // BTCB/WBNB
];

export function getBnbPriceInUSD(): BigDecimal {
  // Bind WBNB/BUSD contract to query the pair.
  let pairContract = Pair.bind(Address.fromString(TRACKED_PAIRS[0]));

  // Fail-safe call to get BNB price as BUSD.
  let reserves = pairContract.try_getReserves();
  if (!reserves.reverted) {
    let reserve0 = reserves.value.value0.toBigDecimal().div(BD_1E18);
    let reserve1 = reserves.value.value1.toBigDecimal().div(BD_1E18);

    if (reserve0.notEqual(BD_ZERO)) {
      return reserve1.div(reserve0);
    }
  }

  return BD_ZERO;
}
