/**
 * The seeded noon Atlas — the 17 screens and 18 flows that were previously
 * hardcoded inside `AtlasBoards.tsx`, now the seed layer of the data layer —
 * plus the New PDP (screen 18, flow 19), mapped widget-for-widget from Figma
 * node 1447:13037.
 *
 * ⚠️  COORDINATE FIDELITY: these x/y values are the exact Figma world coordinates
 * from the "Dummy flows" section (node 71:104076). `2237.67` and `2238` on the
 * gift-card boards are deliberately off-grid — they are NOT typos and must not be
 * rounded to 2238/2237. 1:1 fidelity with the design file is the product's whole
 * claim, so these were copied, not retyped. Verify with a screenshot diff after
 * any edit here.
 */

import type {
  AtlasSnapshot,
  Device,
  Flow,
  Journey,
  Project,
  ProjectId,
  Screen,
  Section,
} from '../../domain/types'

/** Fixed so the seed is a pure value — no clock, no nondeterminism in tests. */
const SEED_TIMESTAMP = '2025-08-01T00:00:00.000Z'

/**
 * The artboards are 400×865 design frames. The pre-refactor inspector hardcoded
 * "iphone 13 Pro / 375 x 812", which is wrong on both axes (and 375×812 is an
 * iPhone X/11 Pro, not a 13 Pro). We report what the asset actually is.
 */
const ARTBOARD: Device = { name: 'Artboard', width: 400, height: 865 }

export const SEEDED_PROJECT_ID: ProjectId = 'noon-homepage'

/**
 * Artboards are served as JPEG rather than PNG.
 *
 * The PNGs totalled 3.2 MB across 17 screens, which is why boards visibly popped in as
 * you panned. They're opaque UI screenshots with no transparency, so JPEG at q80 gives
 * the same picture for 1.4 MB — a 56% saving with no tooling beyond what macOS ships.
 * WebP would do better again (~700 KB) but needs a build-time encoder this project
 * doesn't have yet.
 *
 * Note `mergeSeed` gives the seed authority over `imageUrl` precisely so a change like
 * this reaches people who have already opened the app; had stored values won, returning
 * users would be pinned to the old PNGs forever.
 */
const screenImage = (id: string) => `/images/screens/${id}.jpg`

type SeedScreen = { id: string; label: string; x: number; y: number }

// The 18 screens — 17 at their exact Figma positions within the flows section, plus the
// New PDP (node 1447:13037 in the Saransh-s file), which has no position in the "Dummy
// flows" section, so it takes the free slot one home-row pitch (600) left of the
// homepage it hangs off.
const SEED_SCREENS: SeedScreen[] = [
  { id: 'home', label: 'Homepage', x: 1583, y: 877 },
  { id: 'pdp', label: 'New PDP', x: 983, y: 877 },
  { id: 'supermall', label: 'Supermall', x: 1327, y: 100 },
  { id: 'noon-food', label: 'noon Food', x: 1583, y: 100 },
  { id: 'noon-minutes', label: 'noon Minutes', x: 1839, y: 100 },
  { id: 'account', label: 'Account', x: 100, y: 1252 },
  { id: 'cart', label: 'Cart', x: 356, y: 1252 },
  { id: 'one-sale', label: 'one Sale', x: 612, y: 1252 },
  { id: 'categories', label: 'Categories', x: 2183, y: 877 },
  { id: 'electronics', label: 'Electronics', x: 2783, y: 877 },
  { id: 'tvs', label: 'TVs & accessories', x: 3415, y: 877 },
  { id: 'premium-tvs', label: 'Premium TVs', x: 4015, y: 877 },
  { id: 'huawei', label: 'Huawei Pura 90s', x: 183, y: 2244 },
  { id: 'mobiles', label: 'Mobiles', x: 812, y: 2244 },
  { id: 'search-page', label: 'Search Page', x: 1253, y: 2244 },
  { id: 'search-powerbank', label: 'Search : Powerbank', x: 1891, y: 2244 },
  { id: 'gift-cards', label: 'Gift cards', x: 2243, y: 2237.67 },
  { id: 'noon-gift-cards', label: 'noon Gift cards', x: 2855, y: 2238 },
]

/**
 * The flows, resolved to screen ids, each with the affordance that triggers it.
 *
 * `action` is what gets drawn on the connector. These are read off the artboards rather
 * than invented — noon's bottom nav genuinely reads Home / Categories / one SALE /
 * Account / Cart, and the homepage's top row genuinely carries the supermall, noon FOOD
 * and 12 MINUTES tiles. So the affordance names are grounded in the screenshots, even
 * though nobody has confirmed that these are the *intended* entry points, and a real app
 * usually offers several routes to the same screen where this records one.
 *
 * Where the trigger isn't legible from the image, `action` is left off and the edge draws
 * unlabelled. Better a sparse graph of true labels than a complete one of guesses.
 */
const SEED_FLOWS: { from: string; to: string; action?: string }[] = [
  { from: 'home', to: 'pdp', action: 'Product card' },
  { from: 'home', to: 'supermall', action: 'supermall tile' },
  { from: 'home', to: 'noon-food', action: 'noon FOOD tile' },
  { from: 'home', to: 'noon-minutes', action: '12 MINUTES tile' },
  { from: 'home', to: 'account', action: 'Account tab' },
  { from: 'home', to: 'cart', action: 'Cart tab' },
  { from: 'home', to: 'one-sale', action: 'one SALE tab' },
  { from: 'home', to: 'categories', action: 'Categories tab' },
  { from: 'home', to: 'mobiles', action: 'Mobiles tile' },
  { from: 'home', to: 'search-page', action: 'Search bar' },
  { from: 'home', to: 'gift-cards', action: 'Gift Cards tile' },
  { from: 'categories', to: 'electronics', action: 'Electronics row' },
  { from: 'electronics', to: 'tvs', action: 'TVs & accessories' },
  { from: 'tvs', to: 'premium-tvs', action: 'Premium TVs' },
  { from: 'mobiles', to: 'huawei', action: 'Product card' },
  { from: 'search-page', to: 'search-powerbank', action: 'Submit “power bank”' },
  { from: 'gift-cards', to: 'noon-gift-cards', action: 'noon Gift cards' },
  { from: 'one-sale', to: 'gift-cards', action: 'Gift Cards deal' },
  { from: 'one-sale', to: 'mobiles', action: 'Mobiles deal' },
]

/**
 * The journey taxonomy — the nested rail in the Screens browser.
 *
 * ⚠️  PROVISIONAL, and marked as such on every entry. Two different things are being
 * claimed here and they carry very different confidence:
 *
 *   The SEQUENCES are real. Every consecutive pair below is an edge in `SEED_FLOWS`
 *   above — these are walks through the actual graph, not invented routes.
 *   `journeyGaps()` re-checks this at render time rather than trusting the comment.
 *
 *   The NAMES AND GROUPINGS are mine. Nobody who works on noon has said "Shop /
 *   Mobiles" is how these screens are filed, or that reaching a phone from the
 *   homepage and reaching it via one Sale are two journeys rather than one. That is
 *   editorial judgement about a product I'm inferring from 17 screenshots.
 *
 * A taxonomy drawn in a tree reads as settled fact, which is exactly why the
 * distinction is surfaced in the UI instead of only living in this comment. Flip
 * `provisional` to false per entry as each one is confirmed by someone who knows.
 */
type SeedJourney = { name: string; category: string[]; screens: string[] }

const SEED_JOURNEYS: SeedJourney[] = [
  // Entry points — one hop off the homepage. Short by nature, not by omission.
  { name: 'Opening the Supermall', category: ['Entry points'], screens: ['home', 'supermall'] },
  { name: 'Opening noon Food', category: ['Entry points'], screens: ['home', 'noon-food'] },
  { name: 'Opening noon Minutes', category: ['Entry points'], screens: ['home', 'noon-minutes'] },

  { name: 'Browsing to Premium TVs', category: ['Shop', 'Categories'], screens: ['home', 'categories', 'electronics', 'tvs', 'premium-tvs'] },
  { name: 'Reaching a phone from the homepage', category: ['Shop', 'Mobiles'], screens: ['home', 'mobiles', 'huawei'] },
  { name: 'Reaching a phone via one Sale', category: ['Shop', 'Mobiles'], screens: ['home', 'one-sale', 'mobiles', 'huawei'] },

  { name: 'Searching for a powerbank', category: ['Search'], screens: ['home', 'search-page', 'search-powerbank'] },

  { name: 'Buying a gift card', category: ['Gift cards'], screens: ['home', 'gift-cards', 'noon-gift-cards'] },
  { name: 'Gift cards via one Sale', category: ['Gift cards'], screens: ['home', 'one-sale', 'gift-cards', 'noon-gift-cards'] },

  { name: 'Opening the cart', category: ['Account & cart'], screens: ['home', 'cart'] },
  { name: 'Opening the account', category: ['Account & cart'], screens: ['home', 'account'] },
]

/**
 * The homepage image is one tall JPG, so its sections are full-width blocks
 * weighted by their rough vertical share of the page (≈100 total). Each block is
 * a hover target that reveals a StatsBar for that section.
 */
const SEED_HOME_SECTIONS: { name: string; weight: number }[] = [
  { name: 'Top Nav & Search', weight: 6 },
  { name: 'Welcome Banner', weight: 5 },
  { name: 'Cashback Strip', weight: 3 },
  { name: 'Shop by Category', weight: 9 },
  { name: 'Recommended for you', weight: 12 },
  { name: 'Offers for you', weight: 6 },
  { name: 'Mega Deals', weight: 16 },
  { name: 'Bestsellers', weight: 10 },
  { name: 'Keep shopping for', weight: 6 },
  { name: 'Summer Essentials', weight: 8 },
  { name: 'Selling out fast', weight: 9 },
  { name: 'New Launches', weight: 10 },
]

/**
 * The New PDP's sections — one per widget, named EXACTLY as the layers are named in
 * Figma (node 1447:13037, frame 375×6770). Verbatim means verbatim: the stray trailing
 * quote on `Offers for you"`, the trailing space on `Top products in chargers `, and the
 * unnamed `Frame 2147238764` (the free-gifts strip) are all in the design file. Renaming
 * them here would hide that from the person who can actually fix it — the file's owner.
 *
 * `top` is each widget's absolute y in the frame (children of the y=560 content wrapper
 * are offset by +560), at full Figma precision per the coordinate-fidelity rule above.
 * A section extends to the next widget's top — inter-widget padding belongs to the
 * widget above, which is how the padding reads visually. The Header overlaps the Image
 * node (y=40) as a floating bar; a linear strip can't express overlap, so the Image
 * section begins where the Header's own box ends (y=103). The floating `Pill Button`
 * (y=6621, 106×32) is skipped for the same reason. Weights are the raw pixel heights —
 * MasterImage consumes them as flex ratios, so pixels preserve the exact proportions
 * with no rounding step.
 */
const PDP_FRAME_H = 6770

const SEED_PDP_WIDGETS: { name: string; top: number }[] = [
  { name: 'Header', top: 0 },
  { name: 'Image', top: 103 },
  { name: 'Main-Info', top: 560 },
  { name: 'In this combo', top: 934 },
  { name: 'Ads', top: 1079.1943359375 },
  { name: 'Delivery information', top: 1169.1944580078125 },
  { name: 'Frame 2147238764', top: 1485.1306762695312 },
  { name: 'Variant picker', top: 1632.130615234375 },
  { name: 'Offers for you"', top: 1995.130615234375 },
  { name: 'Trustmarker', top: 2126.130859375 },
  { name: 'Product Overview', top: 2242.130615234375 },
  { name: 'Trustmarker', top: 2463.130615234375 },
  { name: 'Bestseller', top: 2676.130615234375 },
  { name: 'Seller widget', top: 2750.130615234375 },
  { name: 'Product features', top: 3042.130615234375 },
  { name: 'Variant Selection', top: 3664.130615234375 },
  { name: 'Details', top: 3839.130615234375 },
  { name: 'Variant Selection', top: 4129.130615234375 },
  { name: 'Product Review Card', top: 4471.130615234375 },
  { name: 'Similar products', top: 5897.130859375 },
  { name: 'Top products in chargers ', top: 6280.79736328125 },
  { name: 'Bottom Nav', top: 6665 },
]

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export const flowId = (from: string, to: string) => `flow-${from}-${to}`
export const sectionId = (screenId: string, name: string) => `sec-${screenId}-${slug(name)}`
/** Path-qualified, so two categories can both hold a "Direct from the homepage". */
export const journeyId = (category: string[], name: string) =>
  `jny-${[...category, name].map(slug).join('-')}`

/**
 * Every project the Sidebar offers. Only `noon-homepage` has a graph; the rest are
 * real-but-empty and render an honest "no screens yet" state.
 *
 * Deliberately NOT fake-cloning the 17 screens into all of them: it impresses for
 * about ten seconds, and then every audience rightly distrusts every number on
 * screen. An honest empty state generates feature requests; fake data leaks
 * credibility.
 */
const SEED_PROJECT_DEFS: Array<Pick<Project, 'id' | 'name' | 'kind' | 'seeded'>> = [
  { id: SEEDED_PROJECT_ID, name: 'noon Homepage', kind: 'project', seeded: true },
  { id: 'order-2-0', name: 'Order 2.0', kind: 'project', seeded: false },
  { id: 'back-to-school', name: 'Back to school', kind: 'project', seeded: false },
  { id: 'image-first-navigation', name: 'Image first navigation', kind: 'project', seeded: false },
  { id: 'coupons-revamp-v2', name: 'Coupons Revamp V2', kind: 'project', seeded: false },
  { id: 'prism-v2', name: 'Prism V2', kind: 'project', seeded: false },
  { id: 'unboxed', name: 'Unboxed', kind: 'project', seeded: false },
  { id: 'noon-one', name: 'noon one', kind: 'pod', seeded: false },
  { id: 'ugc', name: 'UGC', kind: 'pod', seeded: false },
  { id: 'storefront', name: 'Storefront', kind: 'pod', seeded: false },
  { id: 'sales', name: 'Sales', kind: 'pod', seeded: false },
  { id: 'afs', name: 'AFS', kind: 'pod', seeded: false },
  { id: 'special-projects', name: 'Special projects', kind: 'pod', seeded: false },
]

export const SEED_PROJECTS: Project[] = SEED_PROJECT_DEFS.map((p) => ({
  ...p,
  slug: p.id,
  createdAt: SEED_TIMESTAMP,
  updatedAt: SEED_TIMESTAMP,
}))

export function findSeedProject(idOrSlug: string): Project | undefined {
  return SEED_PROJECTS.find((p) => p.id === idOrSlug || p.slug === idOrSlug)
}

/** A fresh snapshot of the seeded project — the reset baseline. */
export function buildSeededAtlas(): AtlasSnapshot {
  const projectId = SEEDED_PROJECT_ID

  // Screens with a full-length scrollable mockup. Everything else previews its artboard.
  const previews: Record<string, string> = {
    home: '/images/homepage.jpg',
    pdp: '/images/pdp.jpg',
  }

  // The PDP's Figma frame is 375 wide, not 400, so its board crop is 375×812 — same
  // 200:433.33 frame aspect as every other board, at the asset's native width. The
  // device reports the crop, exactly as `home` reports its 400×865 crop rather than
  // the 430×7800 full page.
  const devices: Record<string, Device> = {
    pdp: { name: 'Artboard', width: 375, height: 812 },
  }

  const screens: Screen[] = SEED_SCREENS.map((s, order) => ({
    id: s.id,
    projectId,
    label: s.label,
    imageUrl: screenImage(s.id),
    previewUrl: previews[s.id],
    position: { x: s.x, y: s.y },
    homePosition: { x: s.x, y: s.y },
    device: devices[s.id] ?? ARTBOARD,
    order,
  }))

  const flows: Flow[] = SEED_FLOWS.map(({ from, to, action }) => ({
    id: flowId(from, to),
    projectId,
    from,
    to,
    // Kept for the inspector's heading, where "Homepage to Cart" reads correctly because
    // there's no arrow beside it. The canvas draws `action` instead — see `Flow.action`.
    label: `${SEED_SCREENS.find((s) => s.id === from)?.label} to ${
      SEED_SCREENS.find((s) => s.id === to)?.label
    }`,
    action,
  }))

  const homeSections: Section[] = SEED_HOME_SECTIONS.map((s, order) => ({
    id: sectionId('home', s.name),
    screenId: 'home',
    name: s.name,
    weight: s.weight,
    order,
  }))

  // Figma legitimately repeats layer names (two Trustmarkers, two Variant Selections),
  // but section ids must be unique — repeats get an occurrence suffix while the display
  // name stays verbatim.
  const seenPdpIds = new Map<string, number>()
  const pdpSections: Section[] = SEED_PDP_WIDGETS.map((w, order) => {
    const nextTop = SEED_PDP_WIDGETS[order + 1]?.top ?? PDP_FRAME_H
    const base = sectionId('pdp', w.name)
    const n = (seenPdpIds.get(base) ?? 0) + 1
    seenPdpIds.set(base, n)
    return {
      id: n === 1 ? base : `${base}-${n}`,
      screenId: 'pdp',
      name: w.name,
      weight: nextTop - w.top,
      order,
    }
  })

  const sections: Section[] = [...homeSections, ...pdpSections]

  const journeys: Journey[] = SEED_JOURNEYS.map((j) => ({
    id: journeyId(j.category, j.name),
    projectId,
    name: j.name,
    categoryPath: j.category,
    screenIds: j.screens,
    // Uniformly true today. Per-entry rather than a single flag on the snapshot, so
    // confirming one journey doesn't require confirming all eleven.
    provisional: true,
  }))

  return {
    project: findSeedProject(projectId)!,
    screens,
    flows,
    sections,
    journeys,
    rootScreenId: 'home',
    rev: 1,
  }
}

/** An empty project — selectable, but with no graph yet. */
export function buildEmptyAtlas(project: Project): AtlasSnapshot {
  return {
    project,
    screens: [],
    flows: [],
    sections: [],
    journeys: [],
    rootScreenId: '',
    rev: 1,
  }
}

export function buildSeedAtlas(project: Project): AtlasSnapshot {
  return project.seeded ? buildSeededAtlas() : buildEmptyAtlas(project)
}
