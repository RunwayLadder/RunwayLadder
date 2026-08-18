import { useState } from 'react'
import { ladder, PROTOTYPE_NOTICE, type Rung, rungs, treasury } from '@/lib/treasuryMock'
import { BuildLadder } from '@/views/BuildLadder'
import { LadderDashboard } from '@/views/LadderDashboard'
import { RungDetail } from '@/views/RungDetail'

type View = 'build' | 'dashboard' | 'detail'

const NAV: { id: View; label: string }[] = [
  { id: 'build', label: 'Build ladder' },
  { id: 'dashboard', label: 'Ladder dashboard' },
  { id: 'detail', label: 'Rung detail' },
]

const App = () => {
  const [view, setView] = useState<View>('build')
  const [selectedRung, setSelectedRung] = useState<Rung>(rungs[0])

  const openRung = (rung: Rung) => {
    setSelectedRung(rung)
    setView('detail')
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b border-border bg-[hsl(var(--surface-raised))] px-4 py-1.5 text-center text-xs text-muted-foreground">
        {PROTOTYPE_NOTICE}
      </div>

      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-end justify-between gap-4 px-4 py-4 md:px-6">
          <div>
            <div className="label-caps">TreasuryRunway · fixed-income layer</div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">{treasury.name}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {treasury.owner} · <span className="num">{treasury.address}</span> · {treasury.asset}{' '}
              on {treasury.network}
            </p>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-1 text-xs text-muted-foreground">
            <span>
              Total stablecoin balance{' '}
              <span className="num text-foreground">{treasury.totalBalance} USDC</span>
            </span>
            <span>
              Laddered <span className="num text-foreground">{treasury.laddered}</span> · Floating{' '}
              <span className="num text-foreground">{treasury.floating}</span> at{' '}
              <span className="num text-foreground">{treasury.floatingRate}</span>
            </span>
            <span>
              Ladder <span className="num text-foreground">{ladder.id}</span>
            </span>
          </div>
        </div>

        <nav className="mx-auto flex max-w-[1440px] gap-1 px-4 md:px-6">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? 'page' : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                view === item.id
                  ? 'border-[hsl(var(--primary))] text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-5 md:px-6">
        {view === 'build' && <BuildLadder onConfirm={() => setView('dashboard')} />}
        {view === 'dashboard' && <LadderDashboard onOpenRung={openRung} />}
        {view === 'detail' && (
          <RungDetail rung={selectedRung} onBack={() => setView('dashboard')} />
        )}
      </main>
    </div>
  )
}

export default App
