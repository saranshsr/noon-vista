import { RollingNumber } from '../components/RollingNumber'
type Stat = { label: string; value: string }

type StatsBarProps = {
  title?: string
  primary?: Stat[]
  secondary?: Stat[]
  animate?: boolean
}

const GREEN = '#26B57C'
const ORANGE = '#FFA852'

const DEFAULT_PRIMARY: Stat[] = [
  { label: 'Users per day', value: '583097' },
  { label: 'Impressions', value: '100.0%' },
]

const DEFAULT_SECONDARY: Stat[] = [
  { label: 'GP of Widget', value: '0.67' },
  { label: 'Conversion Rate', value: '0.89%' },
  { label: 'ATC GMV / user', value: '375.53' },
  { label: 'ATC GMV / day', value: '1,948,837' },
  { label: 'Monetisation / day', value: '380,000' },
]

function StatRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 24 }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 8, height: 8, background: color, flex: '0 0 auto' }} />
        <span
          className="pixel-line"
          style={{ width: 160, fontSize: 14, lineHeight: 'normal', color: 'rgba(255, 255, 255, 0.64)' }}
        >
          {label}
        </span>
      </div>
      {/* Reels, not text: hovering across sections swaps every value at once, and a
          hard swap reads as a repaint. Rolling digits make the change legible — you
          SEE which numbers moved. Mount stays silent (RollDigit only animates on
          change), so the card's entrance doesn't spin seven reels at once. */}
      <span className="pixel" style={{ fontSize: 14, lineHeight: 1, color: '#FFFFFF' }}>
        <RollingNumber value={value} />
      </span>
    </div>
  )
}

export function StatsBar({
  title = 'Homepage Banner',
  primary = DEFAULT_PRIMARY,
  secondary = DEFAULT_SECONDARY,
}: StatsBarProps) {
  const tick = {
    position: 'absolute' as const,
    top: 20,
    width: 1,
    height: 24,
    background: '#F7306F',
  }

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        width: 320,
        flexShrink: 0,
        boxSizing: 'border-box',
        gap: 20,
        padding: 20,
        background: 'rgba(255, 255, 255, 0.04)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: 16,
        backdropFilter: 'blur(60px)',
        WebkitBackdropFilter: 'blur(60px)',
      }}
    >
      <span style={{ ...tick, left: 0 }} />
      <span style={{ ...tick, right: 0 }} />

      <div
        className="pixel-square"
        style={{ fontSize: 20, lineHeight: 1, color: '#FFFFFF', whiteSpace: 'nowrap' }}
      >
        {title}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {primary.map((s, i) => (
          <StatRow key={`p-${i}`} label={s.label} value={s.value} color={GREEN} />
        ))}
      </div>

      {secondary.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {secondary.map((s, i) => (
            <StatRow key={`s-${i}`} label={s.label} value={s.value} color={ORANGE} />
          ))}
        </div>
      )}
    </div>
  )
}
