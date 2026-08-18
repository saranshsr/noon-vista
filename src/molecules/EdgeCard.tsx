import type { Metric, MetricSet } from '../domain/metrics'
import { formatMetric } from '../domain/metrics'
import { motion } from 'motion/react'

const ORDER = [
  'flow_users',
  'flow_share',
  'flow_drop_off',
  'flow_conversion',
  'atc_gmv_per_user',
  'atc_gmv_per_day',
  'monetisation_per_day',
  'gp_contribution',
]

const TRAFFIC_KEYS = new Set(['flow_users', 'flow_share', 'flow_drop_off', 'flow_conversion'])

const READABLE: Record<string, string> = {
  flow_users: 'Entry-point CTR',
  flow_share: 'Downstream conversion',
  flow_drop_off: 'Drop off rate',
  flow_conversion: 'Conversion',
  atc_gmv_per_user: 'atc_gmv_per_user',
  atc_gmv_per_day: 'atc_gmv_per_day',
  monetisation_per_day: 'Monetisation_per_day',
  gp_contribution: 'GP contribution',
}

const GREEN = '#26B57C'
const ORANGE = '#FFA852'

function FlowMarker({ color }: { color: string }) {
  return (
    <svg width={8} height={8} viewBox="0 0 8 8" fill="none" style={{ flex: '0 0 auto' }} aria-hidden>
      <path d="M0 0L4 2L8 0L6 4L8 8L4 6L0 8L2 4L0 0Z" fill={color} />
    </svg>
  )
}

export function EdgeCard({
  x,
  y,
  fromLabel,
  toLabel,
  action,
  metrics,
}: {
  x: number
  y: number
  fromLabel: string
  toLabel: string
  action?: string
  metrics: MetricSet | null
}) {
  const all = metrics ? [...metrics.primary, ...metrics.secondary] : []
  const rows = ORDER.map((key) => all.find((m) => m.key === key)).filter(
    (m): m is Metric => Boolean(m),
  )

  const trafficRows = rows.filter((m) => TRAFFIC_KEYS.has(m.key))
  const monetRows = rows.filter((m) => !TRAFFIC_KEYS.has(m.key))

  const left = Math.min(x + 20, window.innerWidth - 400)
  const top = Math.max(16, y + 18)

  return (
    <motion.div
      className="edge-card"
      style={{ left, top }}
      role="tooltip"
      /* Opacity only — this surface carries glass, and a transform would establish a
         backdrop root and kill its own blur. Presence (the exit) is provided by the
         AnimatePresence wrapper at the call site. */
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <div className="edge-card__body">
        <div className="edge-card__header">
          <span className="edge-card__from pixel">{fromLabel} to</span>
          <div className="edge-card__title-wrap">
            <span className="edge-card__accent" />
            <span className="edge-card__to pixel-square">{toLabel}</span>
          </div>
          {action && <span className="edge-card__action pixel">{action}</span>}
        </div>

        <div className="edge-card__stats">
          {rows.length === 0 ? (
            <div className="edge-card__label pixel-line">Loading flow metrics…</div>
          ) : (
            <>
              <div className="edge-card__group">
                {trafficRows.map((m) => (
                  <div className="edge-card__row" key={m.key}>
                    <FlowMarker color={GREEN} />
                    <span className="edge-card__label pixel-line">
                      {READABLE[m.key] || m.label}
                    </span>
                    <span className="edge-card__value pixel">{formatMetric(m)}</span>
                  </div>
                ))}
              </div>
              {monetRows.length > 0 && (
                <div className="edge-card__group">
                  {monetRows.map((m) => (
                    <div className="edge-card__row" key={m.key}>
                      <FlowMarker color={ORANGE} />
                      <span className="edge-card__label pixel-line">
                        {READABLE[m.key] || m.label}
                      </span>
                      <span className="edge-card__value pixel">{formatMetric(m)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </motion.div>
  )
}
