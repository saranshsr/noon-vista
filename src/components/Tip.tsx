import type { ReactNode } from 'react'

/**
 * The house tooltip. Native `title` takes ~a second to appear, renders in OS chrome
 * that matches nothing here, and dies on touch. This is a span-wrapped label that
 * fades in after a short CSS delay — no JS, no timers, no portal: the chrome widgets
 * that use it all sit near the viewport edge with nothing to clip them.
 *
 * Not for canvas content (boards, connectors) — those live under a zoomed transform
 * where a fixed-size label would be wrong. Chrome controls only.
 */
export function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="tip-host">
      {children}
      <span className="tip pixel-line" role="tooltip" aria-hidden>
        {label}
      </span>
    </span>
  )
}
