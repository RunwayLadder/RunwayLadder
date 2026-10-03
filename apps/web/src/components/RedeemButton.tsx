/**
 * The button that redeems a matured rung into the owner's token account (FR-012).
 *
 * Network only: the prototype has no matured rung to redeem, and a button that signs nothing
 * next to a rung that is not due would show a step the treasurer cannot take.
 */

import type { LadderView, RungView } from '@runway-ladder/sdk'
import type { PublicKey } from '@solana/web3.js'
import { Amount, Caption, Caution, Panel, shortSignature } from '@/components/Primitives'
import { formatAmountShown } from '@/lib/amount'
import type { SettlementPreviews } from '@/lib/arrival'
import type { RedeemOutcome } from '@/lib/redeem'
import { useRedeem } from '@/lib/useRedeem'

const BUTTON =
  'w-full rounded-sm px-4 py-2.5 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-40 md:w-auto'

const PRIMARY = {
  backgroundColor: 'hsl(var(--primary))',
  color: 'hsl(var(--primary-foreground))',
}

/**
 * What the treasurer receives, said before the signature. Under a deficit both numbers are
 * shown, as on the rung itself. Before settlement the amount is the program's answer for
 * settling now; only when that answer could not be had is the promise all there is, and the
 * caption says the settlement decides the rest.
 */
const OutcomeLine = ({ outcome, decimals }: { outcome: RedeemOutcome; decimals: number }) => {
  const promised = formatAmountShown(outcome.promised, decimals)

  if (outcome.kind === 'atSettlement') {
    return (
      <Caption>
        Promised <Amount value={promised} />. The epoch has not been settled yet, so this signature
        settles it first: if the base yield fell short, the rung is redeemed with a marked deficit,
        never silently.
        {outcome.reason && ` What it settles for could not be previewed — ${outcome.reason}.`}
      </Caption>
    )
  }

  const amount = formatAmountShown(outcome.amount, decimals)

  if (outcome.kind === 'ifSettledNow') {
    return outcome.amount < outcome.promised ? (
      <Caution>
        This signature settles the epoch first, and as the chain stands now it settles short: you
        receive <Amount value={amount} /> of the promised <Amount value={promised} />, and the
        deficit is marked on the rung.
      </Caution>
    ) : (
      <Caption>
        This signature settles the epoch first; as the chain stands now, you receive{' '}
        <Amount value={amount} /> — the full promised amount.
      </Caption>
    )
  }

  return outcome.amount < outcome.promised ? (
    <Caution>
      You receive <Amount value={amount} /> of the promised <Amount value={promised} /> — the epoch
      settled with a deficit, and every rung in it takes the same ratio.
    </Caution>
  ) : (
    <Caption>
      You receive <Amount value={amount} /> — the full promised amount.
    </Caption>
  )
}

export const RedeemButton = ({
  view,
  entry,
  assetMint,
  decimals,
  rungNumber,
  previews,
}: {
  view: LadderView
  entry: RungView
  assetMint: PublicKey
  decimals: number
  previews: SettlementPreviews
  /** The rung's number as the dashboard table shows it. */
  rungNumber: number
}) => {
  const { action, status, busy, redeem } = useRedeem({ view, entry, assetMint, previews })

  // A closed rung shows its settlement above; the panel stays only to report the
  // signature that closed it.
  if (entry.rung.status.kind !== 'active' && status.kind !== 'done') return null

  const ready = action?.kind === 'ready' ? action : null

  return (
    <Panel title="Redeem" subtitle="Pays into your token account for the market's asset.">
      <div className="px-4 py-3">
        {status.kind === 'done' ? (
          <Caption>
            Redeemed ·{' '}
            <span className="num" title={status.signature}>
              {shortSignature(status.signature)}
            </span>{' '}
            confirmed.
          </Caption>
        ) : (
          <>
            <button
              type="button"
              disabled={!ready || busy}
              onClick={() => void redeem()}
              className={BUTTON}
              style={PRIMARY}
            >
              {ready?.settlesEpoch
                ? `Settle the epoch and redeem rung ${rungNumber} — 1 signature`
                : `Redeem rung ${rungNumber} — 1 signature`}
            </button>

            {status.kind === 'signing' && (
              <Caption>Approve the transaction in your wallet…</Caption>
            )}
            {status.kind === 'confirming' && (
              <Caption>
                Signed as{' '}
                <span className="num" title={status.signature}>
                  {shortSignature(status.signature)}
                </span>{' '}
                — waiting for confirmation.
              </Caption>
            )}
            {status.kind === 'failed' && <Caution>Nothing was redeemed: {status.message}</Caution>}
            {!busy &&
              (action?.kind === 'blocked' ? (
                <Caution>{action.reason}</Caution>
              ) : (
                ready && <OutcomeLine outcome={ready.outcome} decimals={decimals} />
              ))}
          </>
        )}
      </div>
    </Panel>
  )
}
