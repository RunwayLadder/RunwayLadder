/**
 * The button that signs the deposit.
 *
 * Two modes — and the difference between them is named out loud. In the prototype the
 * button signs nothing and leads to a dashboard with mock numbers; on the network it
 * builds the transaction and waits for confirmation. One shared button with a silent
 * difference would be the most expensive lie on this screen: "laddered" and "showed
 * what it would look like" are not the same thing.
 */

import { type LiveNetwork, liveNetwork } from '@/lib/network'
import type { Plan } from '@/lib/plan'
import { useDeposit } from '@/lib/useDeposit'

const BUTTON =
  'w-full rounded-sm px-4 py-2.5 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-40'

const PRIMARY = {
  backgroundColor: 'hsl(var(--primary))',
  color: 'hsl(var(--primary-foreground))',
}

const shortSignature = (signature: string) => `${signature.slice(0, 8)}…${signature.slice(-8)}`

const Caption = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-2 text-xs text-muted-foreground">{children}</p>
)

const Caution = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-2 text-xs" style={{ color: 'hsl(var(--caution))' }}>
    {children}
  </p>
)

/**
 * Prototype: nothing is signed because there is no network. The button moves on to the
 * next screens — and says what it actually did, so "Deposit" does not read as a done deal.
 */
const PrototypeDeposit = ({ plan, onDone }: { plan: Plan | null; onDone: () => void }) => (
  <>
    <button
      type="button"
      disabled={plan === null}
      onClick={onDone}
      className={BUTTON}
      style={PRIMARY}
    >
      Deposit and build ladder — 1 signature
    </button>
    <Caption>
      Prototype mode: nothing is signed and no funds move. All {plan?.rungs.length ?? 0} rungs would
      be created in a single transaction.
    </Caption>
  </>
)

const ChainDeposit = ({
  net,
  plan,
  rollPolicy,
  pricedFromChain,
  onDone,
}: {
  net: LiveNetwork
  plan: Plan | null
  rollPolicy: boolean
  pricedFromChain: boolean
  onDone: () => void
}) => {
  const { action, status, submit, reset } = useDeposit({ net, plan, rollPolicy, pricedFromChain })

  const ready = action?.kind === 'ready' ? action : null
  const busy = status.kind === 'signing' || status.kind === 'confirming'

  if (status.kind === 'sent') {
    return (
      <>
        <button type="button" onClick={onDone} className={BUTTON} style={PRIMARY}>
          Open the ladder
        </button>
        <Caption>
          {status.opensLadder ? 'Ladder opened and funded' : 'Deposited into your ladder'} ·{' '}
          <span className="num" title={status.signature}>
            {shortSignature(status.signature)}
          </span>{' '}
          confirmed.
        </Caption>
      </>
    )
  }

  return (
    <>
      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => void submit()}
        className={BUTTON}
        style={PRIMARY}
      >
        {ready?.opensLadder === false
          ? 'Deposit into your ladder — 1 signature'
          : 'Open ladder and deposit — 1 signature'}
      </button>

      {status.kind === 'signing' && <Caption>Approve the transaction in your wallet…</Caption>}
      {status.kind === 'confirming' && (
        <Caption>
          Signed as{' '}
          <span className="num" title={status.signature}>
            {shortSignature(status.signature)}
          </span>{' '}
          — waiting for confirmation.
        </Caption>
      )}

      {status.kind === 'failed' && (
        <>
          <Caution>Nothing was deposited: {status.message}</Caution>
          <button
            type="button"
            onClick={reset}
            className="mt-2 text-xs text-muted-foreground underline hover:text-foreground"
          >
            Try again
          </button>
        </>
      )}

      {status.kind === 'idle' &&
        (action?.kind === 'blocked' ? (
          <Caution>{action.reason}</Caution>
        ) : (
          <Caption>
            All {plan?.rungs.length ?? 0} rungs are created in a single transaction
            {ready?.opensLadder ? ', which also opens the ladder' : ''}. Funds come from{' '}
            <span className="num" title={ready?.sourceToken.toBase58()}>
              your token account
            </span>
            .
          </Caption>
        ))}
    </>
  )
}

/**
 * The branch is stable across renders (`liveNetwork` is read once at load),
 * so wallet hooks are never called where the providers are absent.
 */
export const DepositButton = ({
  plan,
  rollPolicy,
  pricedFromChain,
  onDone,
}: {
  plan: Plan | null
  rollPolicy: boolean
  pricedFromChain: boolean
  onDone: () => void
}) =>
  liveNetwork ? (
    <ChainDeposit
      net={liveNetwork}
      plan={plan}
      rollPolicy={rollPolicy}
      pricedFromChain={pricedFromChain}
      onDone={onDone}
    />
  ) : (
    <PrototypeDeposit plan={plan} onDone={onDone} />
  )
