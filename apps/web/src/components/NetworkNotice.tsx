/**
 * The strip under the header: where the numbers on screen came from.
 *
 * In M0 this was a single line, "Prototype — mock data". Now there are more states, and
 * none of them may be shown silently: a connected network from which nothing has been
 * read yet looks exactly like a prototype on mocks — which is precisely why the strip
 * names what has been read, rather than saying "Live".
 */

import { useWallet } from '@solana/wallet-adapter-react'
import { useLadder, useProgramStatus } from '@/lib/chain'
import { type LiveNetwork, liveNetwork, network } from '@/lib/network'
import { PROTOTYPE_NOTICE } from '@/lib/treasuryMock'

/**
 * The owner's first ladder. The number stays fixed until the form (T029) learns
 * to open subsequent ones: `seed` is part of the PDA seeds, and inventing it
 * here would mean looking up a ladder at an address nobody ever created.
 */
export const FIRST_LADDER_SEED = 0n

const offlineReason = network.kind === 'offline' ? network.reason : ''

const Cell = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <span className="whitespace-nowrap">
    <span className="label-caps mr-1.5">{label}</span>
    {children}
  </span>
)

/** Mock screens — what M0 showed. There is no network, and that is said plainly. */
const OfflineNotice = ({ reason }: { reason: string }) => (
  <div className="border-b border-border bg-[hsl(var(--surface-raised))] px-4 py-1.5 text-center text-xs text-muted-foreground">
    {PROTOTYPE_NOTICE} <span className="opacity-70">{reason}</span>
  </div>
)

const LiveNotice = ({ net }: { net: LiveNetwork }) => {
  const { publicKey } = useWallet()
  const program = useProgramStatus()
  const ladder = useLadder(publicKey ?? null, FIRST_LADDER_SEED)

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 border-b border-border bg-[hsl(var(--surface-raised))] px-4 py-1.5 text-xs text-muted-foreground">
      <Cell label="Network">
        <span className="num text-foreground">{net.cluster}</span>
      </Cell>

      <Cell label="RPC">
        <span className="num">{net.endpoint}</span>
      </Cell>

      <Cell label="Program">
        {program.isPending && <span>reading…</span>}
        {program.isError && <span className="text-[hsl(var(--caution))]">RPC unreachable</span>}
        {program.data && (
          <span
            className={program.data.deployed ? 'text-foreground' : 'text-[hsl(var(--caution))]'}
          >
            {program.data.deployed ? 'deployed' : 'not deployed here'}
          </span>
        )}
      </Cell>

      <Cell label="Ladder">
        {!publicKey && <span>connect a wallet to read yours</span>}
        {publicKey && ladder.isPending && <span>reading…</span>}
        {publicKey && ladder.isError && (
          <span className="text-[hsl(var(--caution))]">read failed</span>
        )}
        {publicKey && ladder.data === null && <span>none opened yet</span>}
        {publicKey && ladder.data && (
          <span className="text-foreground">
            <span className="num">{ladder.data.rungs.length}</span> rungs on chain
          </span>
        )}
      </Cell>

      <span className="opacity-70">
        Figures on the screens below are still prototype data — the network path ends here.
      </span>
    </div>
  )
}

export const NetworkNotice = () =>
  liveNetwork ? <LiveNotice net={liveNetwork} /> : <OfflineNotice reason={offlineReason} />
