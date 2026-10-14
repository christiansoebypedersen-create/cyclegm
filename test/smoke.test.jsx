// @vitest-environment jsdom
// Headless render smoke test.
//
// The recurring failure mode is "compiles fine, white-screens at runtime on a
// screen I didn't open." This mounts the real app, starts a career, then walks
// every nav screen + every rider-profile tab + every Scouting sub-tab and fails
// loudly if anything throws. lucide-react and facesjs are stubbed so the test
// stays fast and deterministic.

import React from 'react'
import { render, fireEvent, waitFor, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- stub heavy/irrelevant externals ---------------------------------------
// motion/react: the vendored lucide-animated nav icons import it. Render plain
// SVG tags and drop motion-only props so the icons mount without animation.
vi.mock('motion/react', async () => {
  const React = await import('react')
  const MOTION_PROPS = new Set(['animate', 'variants', 'transition', 'initial', 'exit',
    'whileHover', 'whileTap', 'whileInView', 'custom', 'layout', 'layoutId'])
  const make = (tag) => {
    const C = React.forwardRef((props, ref) => {
      const clean = {}
      for (const k in props) if (!MOTION_PROPS.has(k)) clean[k] = props[k]
      return React.createElement(tag, { ...clean, ref })
    })
    C.displayName = `motion.${String(tag)}`
    return C
  }
  const cache = {}
  const motion = new Proxy({}, { get: (_, tag) => (cache[tag] ||= make(typeof tag === 'string' ? tag : 'g')) })
  return {
    motion,
    useAnimation: () => ({ start: () => {}, set: () => {}, stop: () => {} }),
    AnimatePresence: ({ children }) => children,
  }
})
// facesjs: avoid real SVG face generation; Face component just no-ops the canvas.
vi.mock('facesjs', () => ({ __esModule: true, generate: () => ({}), display: () => {} }))

import CycleGM from '../src/App.jsx'

// --- error boundary so render-phase throws surface as a clear failure -------
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) { this.props.onError?.(err) }
  render() { return this.state.err ? null : this.props.children }
}

const NAV = ['Dashboard', 'Inbox', 'Roster', 'Plan', 'Development', 'Scouting',
  'Finances', 'Transfers', 'Calendar', 'Standings', 'History']
const PROFILE_TABS = ['Overview', 'Power', 'Training', 'History', 'Contract']
const SCOUT_TABS = ['Map', 'Reports', 'Youth market', 'My scouts', 'Hire']

describe('app render smoke test', () => {
  let caught
  let errSpy
  beforeEach(() => {
    caught = []
    // React reports recoverable render errors via console.error; capture them.
    errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { caught.push(args) })
  })
  afterEach(() => { errSpy.mockRestore() })

  const assertClean = (where) => {
    // console.error fires for React act() noise too — only fail on real Errors.
    const real = caught.filter((a) => a.some((x) => x instanceof Error))
    if (real.length) throw new Error(`render error on ${where}: ${real[0].find((x) => x instanceof Error)?.stack}`)
  }

  it('mounts, starts a career, and walks every screen without throwing', async () => {
    const boundaryErrors = []
    const { container, getByText, getByRole, queryByRole } = render(
      <Boundary onError={(e) => boundaryErrors.push(e)}><CycleGM /></Boundary>
    )

    // start a fresh career from the menu — pin the world seed first (the menu
    // defaults to Math.random, which made every CI run walk a different world)
    const seedInput = container.querySelector('input[type="number"]')
    expect(seedInput, 'world-seed input not found').toBeTruthy()
    await act(async () => { fireEvent.change(seedInput, { target: { value: '12345' } }) })
    await act(async () => { fireEvent.click(getByText('Start career →')) })
    await waitFor(() => expect(queryByRole('button', { name: 'Roster' })).toBeTruthy())
    assertClean('career start')
    expect(boundaryErrors, 'boundary caught error at start').toHaveLength(0)

    // every nav screen
    for (const label of NAV) {
      await act(async () => { fireEvent.click(getByRole('button', { name: label })) })
      await waitFor(() => {}) // flush effects
      assertClean(`nav: ${label}`)
      expect(boundaryErrors, `boundary caught on ${label}`).toHaveLength(0)
    }

    // Scouting sub-tabs
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Scouting' })) })
    for (const sub of SCOUT_TABS) {
      const btn = within(container).queryAllByRole('button').find((b) => b.textContent?.trim().startsWith(sub))
      expect(btn, `scouting sub-tab "${sub}" not found`).toBeTruthy()
      await act(async () => { fireEvent.click(btn) })
      await waitFor(() => {})
      assertClean(`scouting sub-tab: ${sub}`)
      expect(boundaryErrors, `boundary caught on scouting/${sub}`).toHaveLength(0)
    }

    // open a rider from the Roster and walk every profile tab
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Roster' })) })
    await waitFor(() => expect(container.querySelector('.tbl tbody tr')).toBeTruthy())
    const nameCell = container.querySelector('.tbl tbody tr td:nth-child(2)')
    expect(nameCell, 'roster name cell not found').toBeTruthy()
    await act(async () => { fireEvent.click(nameCell) })
    await waitFor(() => expect(container.querySelector('.modal .rp-tabs')).toBeTruthy())
    assertClean('open rider')

    for (const t of PROFILE_TABS) {
      const tabs = container.querySelector('.modal .rp-tabs')
      const tabBtn = within(tabs).queryAllByRole('button').find((b) => b.textContent?.trim() === t)
      expect(tabBtn, `profile tab "${t}" not found`).toBeTruthy()
      await act(async () => { fireEvent.click(tabBtn) })
      await waitFor(() => {})
      assertClean(`profile tab: ${t}`)
      expect(boundaryErrors, `boundary caught on profile/${t}`).toHaveLength(0)
    }

    // open the pre-race tactics screen and exercise "Recommend tactics"
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Dashboard' })) }) // unmount the rider modal
    const playBtn = within(container).queryAllByRole('button').find((b) => /Continue|Off-season/.test(b.textContent || ''))
    expect(playBtn, 'play menu button not found').toBeTruthy()
    await act(async () => { fireEvent.click(playBtn) })
    const openRaceBtn = within(container).queryAllByRole('button').find((b) => /Open next race weekend/.test(b.textContent || ''))
    if (openRaceBtn) {
      await act(async () => { fireEvent.click(openRaceBtn) })
      await waitFor(() => expect(
        within(container).queryAllByRole('button').some((b) => /Recommend tactics/.test(b.textContent || ''))
      ).toBe(true))
      assertClean('race weekend / tactics')
      const recBtn = within(container).queryAllByRole('button').find((b) => /Recommend tactics/.test(b.textContent || ''))
      await act(async () => { fireEvent.click(recBtn) })
      await waitFor(() => {})
      assertClean('recommend tactics')
      expect(boundaryErrors, 'boundary caught on tactics').toHaveLength(0)
    }

    expect(boundaryErrors).toHaveLength(0)
  })
})
