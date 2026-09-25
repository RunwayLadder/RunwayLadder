import { assertAmount } from './guards.js'

/** What the epoch has on the maturity date, before anyone is paid. */
export type EpochMaturity = {
  /** The sum of promises across the epoch — `Epoch.total_promised`. */
  promised: bigint
  /**
   * What the yield source actually returned: the principal that went to work plus the
   * income it accrued. A source that lost principal simply returns less than it took.
   */
  realized: bigint
  /**
   * The protocol buffer: the only thing standing between a shortfall and the treasury's
   * principal. Filled by fees (FR-023) and by the surplus of epochs that came in above
   * their promise (FR-011b).
   */
  buffer: bigint
}

/**
 * The epoch's settlement — computed once, then applied to every rung with `payout()`.
 *
 * Two variants instead of a `deficit` field next to `paid`: a deficit that is not marked
 * must be unrepresentable, and `{ status: 'settled', paid < promised }` is exactly the state
 * the type does not allow to exist. `SettledWithDeficit` carries the deficit because it is
 * never zero there; `Settled` carries the surplus because the deficit is always zero there.
 */
export type Settlement =
  | {
      readonly status: 'settled'
      readonly promised: bigint
      /** Equals `promised`. */
      readonly paid: bigint
      /** What is left above the promise — it goes to the protocol buffer (FR-011b). */
      readonly surplus: bigint
      readonly fromBuffer: bigint
    }
  | {
      readonly status: 'settledWithDeficit'
      readonly promised: bigint
      /** Strictly less than `promised`. */
      readonly paid: bigint
      /** `promised - paid`, never zero. */
      readonly deficit: bigint
      /** Equals the whole buffer: the haircut comes only after it is drained. */
      readonly fromBuffer: bigint
    }

/**
 * Covering a shortfall: the protocol buffer, then a pro-rata haircut (FR-011). The only
 * implementation of the order, mirrored one-to-one in `programs/runway-ladder/src/math.rs`
 * on the same vectors.
 *
 * The order is what makes the promise a promise. The buffer is the protocol's own money and
 * it goes first; the treasury takes a haircut only when the buffer is gone — and the haircut
 * is a separate variant, never a smaller number under the same label.
 *
 * **There is no yield-pool step, and this is a decision rather than an omission
 * (2026-09-25).** A three-step order once put "the yield owners' income" ahead of the
 * buffer, but that income is already inside `realized`: by the time `realized < promised`
 * the yield side has received nothing, so the step could only ever draw zero. Money above
 * `realized` would have to come from a third party underwriting the epoch, and the product
 * has no such party — see `docs/SPEC.md`, FR-011 and "Поза скоупом".
 *
 * Money is never created: `realized + fromBuffer = paid + surplus` holds exactly, and the
 * buffer step draws at most what the buffer holds.
 */
export function waterfall(epoch: EpochMaturity): Settlement {
  const { promised, realized, buffer } = epoch

  assertAmount('promised', promised)
  assertAmount('realized', realized)
  assertAmount('buffer', buffer)

  if (realized >= promised) {
    return {
      status: 'settled',
      promised,
      paid: promised,
      surplus: realized - promised,
      fromBuffer: 0n,
    }
  }

  let shortfall = promised - realized

  const fromBuffer = shortfall < buffer ? shortfall : buffer
  shortfall -= fromBuffer

  if (shortfall === 0n) {
    return { status: 'settled', promised, paid: promised, surplus: 0n, fromBuffer }
  }

  return {
    status: 'settledWithDeficit',
    promised,
    paid: promised - shortfall,
    deficit: shortfall,
    fromBuffer,
  }
}

/**
 * What one rung receives out of the epoch's settlement: its promise scaled by
 * `paid / promised`. One ratio for the whole epoch, so a rung is paid the same whether it
 * is redeemed first or last — a per-rung haircut would favour whoever came first.
 *
 * Rounds down, so the sum over the rungs never exceeds `paid`: rounding leaves dust in the
 * vault rather than creating a unit that is not there. Under a deficit every rung with a
 * non-zero promise receives strictly less than it — the deficit is not lost in rounding.
 */
export function payout(rungPromised: bigint, settlement: Settlement): bigint {
  assertAmount('rungPromised', rungPromised)
  if (rungPromised > settlement.promised) {
    throw new RangeError(
      `rungPromised ${rungPromised} exceeds the epoch's promised ${settlement.promised}`,
    )
  }

  // Not just a shortcut: an empty epoch has `promised = 0`, and dividing by it would be
  // the only way this function could fail. At par there is nothing to scale.
  if (settlement.status === 'settled') return rungPromised

  return (rungPromised * settlement.paid) / settlement.promised
}
