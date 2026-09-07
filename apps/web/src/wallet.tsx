/**
 * Connecting the treasury wallet.
 *
 * The wallet here is not a "login": only the deposit needs a signature (T029+), and
 * reading the ladder needs exactly one thing from it — the owner's address. So the screens
 * stay meaningful without a connection, and the "not connected" state is not
 * an error.
 */

import type { Adapter } from '@solana/wallet-adapter-base'
import { ConnectionProvider, useWallet, WalletProvider } from '@solana/wallet-adapter-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { network } from '@/lib/network'

/**
 * The adapter list is empty on purpose. Wallets register themselves through Wallet
 * Standard, and `WalletProvider` picks them up; a hard-coded list would mean that
 * the wallet the treasury actually uses is simply not visible — and
 * you would only find out from the treasurer.
 *
 * The constant is module-level because `wallets={[]}` would create a new array on every
 * render and restart the provider's initialisation.
 */
const STANDARD_WALLETS_ONLY: Adapter[] = []

/**
 * Providers are mounted only when the RPC is set. The branch is stable across renders
 * (`network` is read once at load), so the hook order does not
 * drift. The alternative — mounting `ConnectionProvider` on a made-up address — would give
 * an application that looks connected and silently reads nothing.
 */
export const WalletBoundary = ({ children }: { children: ReactNode }) => {
  if (network.kind !== 'live') {
    return <>{children}</>
  }

  return (
    <ConnectionProvider endpoint={network.endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={STANDARD_WALLETS_ONLY} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  )
}

const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`

/** The M0 skeleton has no button class — styles there are utility ones, we keep to the same. */
const CHIP =
  'rounded-sm border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50'

/**
 * The connect button. Our own rather than `@solana/wallet-adapter-react-ui`: that package
 * brings its own theme and modal, which would have to be repainted to match
 * the M0 skeleton — more code than writing the list of detected wallets ourselves.
 *
 * Rendered only inside `WalletBoundary` in `live` mode.
 */
export const WalletButton = () => {
  const { wallets, wallet, select, publicKey, connecting, disconnect } = useWallet()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (publicKey) {
    return (
      <div className="flex items-center gap-2">
        <span className="num text-sm" title={publicKey.toBase58()}>
          {shortAddress(publicKey.toBase58())}
        </span>
        <span className="text-xs text-muted-foreground">{wallet?.adapter.name}</span>
        <button type="button" onClick={() => void disconnect()} className={CHIP}>
          Disconnect
        </button>
      </div>
    )
  }

  if (wallets.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        No wallet detected — install a Solana wallet to read your ladder.
      </span>
    )
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={connecting}
        aria-expanded={open}
        aria-haspopup="menu"
        className={CHIP}
      >
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>

      {open && (
        <div
          role="menu"
          className="panel absolute right-0 z-10 mt-1 min-w-[12rem] p-1"
          style={{ backgroundColor: 'hsl(var(--surface-raised))' }}
        >
          {wallets.map((entry) => (
            <button
              key={entry.adapter.name}
              type="button"
              role="menuitem"
              onClick={() => {
                // `select()` only names the wallet; the provider's `autoConnect`
                // connects it — otherwise the wallet window would open twice.
                select(entry.adapter.name)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-[hsl(var(--muted))]"
            >
              {entry.adapter.icon && (
                <img src={entry.adapter.icon} alt="" className="h-4 w-4" aria-hidden="true" />
              )}
              {entry.adapter.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const LiveOwnerAddress = ({ fallback }: { fallback: string }) => {
  const { publicKey } = useWallet()

  return publicKey ? (
    <span className="num text-foreground">{publicKey.toBase58()}</span>
  ) : (
    <span className="num">{fallback}</span>
  )
}

/**
 * The owner's address in the header. The connected wallet replaces the mock address from M0:
 * two addresses on one screen — one real, one invented — is exactly the
 * silent discrepancy the product must not allow itself.
 */
export const OwnerAddress = ({ fallback }: { fallback: string }) =>
  network.kind === 'live' ? (
    <LiveOwnerAddress fallback={fallback} />
  ) : (
    <span className="num">{fallback}</span>
  )

/**
 * The connection corner in the header. The branch lives here rather than in `App` so the
 * screens need not know whether providers are mounted: wallet hooks live only in the `live` branch.
 */
export const WalletCorner = () =>
  network.kind === 'live' ? (
    <WalletButton />
  ) : (
    <span className="text-xs text-muted-foreground">Wallet is off — no RPC configured.</span>
  )
