/**
 * Metrics are modelled separately from the atlas document on purpose: they come
 * from a different backend (an analytics warehouse, not a document store), they
 * are read-only, and they will one day be slow. Coupling them to the document
 * lifecycle would mean a slow analytics query blocking the canvas from painting.
 */

import type { FlowId, ScreenId, SectionId } from './types'

export type MetricScope =
  | { kind: 'screen'; screenId: ScreenId }
  | { kind: 'section'; sectionId: SectionId }
  | { kind: 'flow'; flowId: FlowId }

/** Stable cache/lookup key for a scope. */
export function scopeKey(scope: MetricScope): string {
  switch (scope.kind) {
    case 'screen':
      return `screen:${scope.screenId}`
    case 'section':
      return `section:${scope.sectionId}`
    case 'flow':
      return `flow:${scope.flowId}`
  }
}

/**
 * How a raw number is rendered. The set is driven by what the current design
 * actually displays — `int` is deliberately ungrouped (the "Users per day" reel
 * shows `583097`, not `583,097`) while `intGrouped` is separated. `duration`
 * carries seconds and renders as `1m 36s` — added for the PDP's median-time
 * metric, where `96.00` would read as a count of something.
 */
export type MetricFormat = 'int' | 'intGrouped' | 'fixed2' | 'pct1' | 'pct2' | 'duration'

export interface Metric {
  /** Warehouse column name — the join key to a real backend. */
  key: string
  /** What the UI prints as the row label. */
  label: string
  /**
   * The numeric truth. Carrying a number rather than a pre-formatted string is
   * the whole point: a real backend returns numbers, and deltas, sparklines and
   * sorting all need arithmetic. The UI formats at the edge.
   */
  value: number
  format: MetricFormat
  /** Optional prose definition, surfaced as a tooltip. */
  definition?: string
  /**
   * Change versus the preceding period of the same length, as a percentage.
   * Absent when there's no comparable prior window.
   */
  delta?: number
  /**
   * Whether a rise is good. Drop-off going up is bad; traffic going up is good —
   * so the sign alone can't decide what colour an arrow should be.
   */
  polarity?: 'higherIsBetter' | 'lowerIsBetter'
}

export interface MetricSet {
  scope: MetricScope
  /** Section cards show a title; screen cards don't. */
  title?: string
  /** The large rolling reels. */
  primary: Metric[]
  /** The detail rows beneath. */
  secondary: Metric[]
  asOf: string
  /** true when the numbers are synthetic — lets the UI badge them honestly. */
  mocked: boolean
}

/** Time window a metric set was computed over. Threaded through the URL. */
export type TimeRange = '7d' | '28d' | '90d'
export const DEFAULT_TIME_RANGE: TimeRange = '28d'
export const TIME_RANGES: TimeRange[] = ['7d', '28d', '90d']

/**
 * Render a metric for display. These formats reproduce the exact strings the
 * pre-refactor hardcoded generators produced, so the refactor is visually inert.
 */
export function formatMetric(m: Metric): string {
  switch (m.format) {
    case 'int':
      return String(Math.round(m.value))
    case 'intGrouped':
      return Math.round(m.value).toLocaleString('en-US')
    case 'fixed2':
      return m.value.toFixed(2)
    case 'pct1':
      return `${m.value.toFixed(1)}%`
    case 'pct2':
      return `${m.value.toFixed(2)}%`
    case 'duration': {
      // Seconds in, `1m 36s` out. Sub-minute values drop the minute part rather
      // than printing `0m 42s`.
      const total = Math.round(m.value)
      const mins = Math.floor(total / 60)
      const secs = total % 60
      return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
    }
  }
}

/** `+4.2%` / `−1.8%`, using a real minus sign rather than a hyphen. */
export function formatDelta(delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : ''
  return `${sign}${Math.abs(delta).toFixed(1)}%`
}

/** Is this movement good, bad, or neutral? Drives the colour, not the sign. */
export function deltaSentiment(m: Metric): 'good' | 'bad' | 'neutral' {
  if (m.delta == null || Math.abs(m.delta) < 0.05) return 'neutral'
  const betterUp = (m.polarity ?? 'higherIsBetter') === 'higherIsBetter'
  const rising = m.delta > 0
  return rising === betterUp ? 'good' : 'bad'
}
