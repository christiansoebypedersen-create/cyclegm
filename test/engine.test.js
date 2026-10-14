// Race-engine validation: the required scenario checks for the segment/group core.
import { describe, it, expect } from 'vitest'
import { simulate, buildField, makeRng, segmentize } from '../src/engine.mjs'

const FLAT = { name: 'Flat stage', lengthKm: 178, finishType: 'flat', segments: [[0, 150, 0], [150, 178, 0]] }
const SUMMIT = { name: 'Queen stage', lengthKm: 172, finishType: 'summit',
  segments: [[0, 60, 0.005], [60, 85, 0.06], [85, 110, -0.04], [110, 140, 0.01], [140, 150, 0.04], [150, 172, 0.082]] }
const HILLY = { name: 'Hilly stage', lengthKm: 196, finishType: 'hilly',
  segments: [[0, 40, 0.01], [40, 70, 0.035], [70, 90, -0.03], [90, 130, 0.015], [130, 150, 0.05], [150, 170, -0.04], [170, 196, 0]] }

const field = () => buildField(makeRng(42), 18, 7)
const run = (stage, seed, tune = {}) => simulate(field(), stage, tune, seed, [], { frames: false })

describe('segmentize', () => {
  it('classifies terrain and marks the finish climb', () => {
    const segs = segmentize(SUMMIT)
    expect(segs.some((s) => s.type === 'climb')).toBe(true)
    expect(segs.some((s) => s.type === 'descent')).toBe(true)
    expect(segs[segs.length - 1].finishClimb).toBe(true)
    expect(segs.every((s) => s.toKm > s.fromKm)).toBe(true)
    expect(segs[segs.length - 1].toKm).toBe(SUMMIT.lengthKm)
  })
})

describe('determinism', () => {
  it('same seed → identical result; different seed → plausible variation', () => {
    const a = run(SUMMIT, 7), b = run(SUMMIT, 7), c = run(SUMMIT, 8)
    expect(a.results.map((r) => r.id)).toEqual(b.results.map((r) => r.id))
    expect(a.results.map((r) => r.gapSec)).toEqual(b.results.map((r) => r.gapSec))
    expect(a.log.map((e) => e.text)).toEqual(b.log.map((e) => e.text))
    expect(c.results.map((r) => r.id)).not.toEqual(a.results.map((r) => r.id))
  })
})

describe('terrain honesty', () => {
  it('flat stages usually end in fast-man wins from a bunch', () => {
    let sprinterWins = 0, runs = 8
    for (let s = 1; s <= runs; s++) {
      const out = run(FLAT, s * 13)
      const w = out.results[0]
      if (w.archetype === 'sprinter' || w.archetype === 'leadout' || w.archetype === 'puncheur') sprinterWins++
    }
    expect(sprinterWins, 'fast finishers dominate flat stages').toBeGreaterThanOrEqual(6)
    // bunch finish: many riders on the winner's time
    const out = run(FLAT, 99)
    const sameTime = out.results.filter((r) => r.gapSec <= 1).length
    expect(sameTime).toBeGreaterThan(20)
  })

  it('mountain stages favor climbers/GC and open real gaps', () => {
    let climberWins = 0, runs = 8
    for (let s = 1; s <= runs; s++) {
      const out = run(SUMMIT, s * 17)
      if (['climber', 'gc'].includes(out.results[0].archetype)) climberWins++
    }
    expect(climberWins, 'climbers/GC win summits').toBeGreaterThanOrEqual(5)
    const out = run(SUMMIT, 5)
    const p20 = out.results[19]
    expect(p20.gapSec, '20th place minutes back on a queen stage').toBeGreaterThan(60)
    expect(out.results[out.results.length - 1].gapSec).toBeLessThan(4000)  // grupetto arrives, not absurd
  })

  it('hilly stages are sometimes selective, sometimes regroup (46km run-in)', () => {
    // NOTE: recalibrated after fixing ghost pass-through merges — dead groups used to finish
    // on separate clocks, which read as fake "selectivity". With physical merges, a hilly
    // profile whose last climb tops 46km from the line legitimately regroups most days.
    let selective = 0, fullBunch = 0, runs = 8
    for (let s = 1; s <= runs; s++) {
      const out = run(HILLY, s * 19, { breakBias: 0.3 })
      const sameTime = out.results.filter((r) => r.gapSec <= 1).length
      if (sameTime < 70) selective++
      if (sameTime > 100) fullBunch++
    }
    expect(selective, 'some hilly days split up').toBeGreaterThanOrEqual(2)
    expect(fullBunch, 'the whole field never finishes together on a hilly day').toBe(0)
  })
})

describe('breakaway ecology', () => {
  it('breaks sometimes survive on loose-leash days, rarely on flat sprint days', () => {
    const breakSurvives = (stage, tune, seed) => {
      const out = simulate(field(), stage, tune, seed, [], { frames: false })
      // did anyone from the opening break win?
      const breakNames = (out.log[0].text.match(/: (.+)\.$/) || [, ''])[1].split(', ')
      return breakNames.some((n) => out.results[0].short === n)
    }
    let flatWins = 0, hillyWins = 0
    for (let s = 1; s <= 10; s++) {
      if (breakSurvives(FLAT, { breakBias: 0.05 }, s * 23)) flatWins++
      if (breakSurvives(HILLY, { breakBias: 0.45 }, s * 23)) hillyWins++
    }
    expect(flatWins, 'sprint days almost always come back together').toBeLessThanOrEqual(2)
    expect(hillyWins, 'the break wins some loose days').toBeGreaterThanOrEqual(1)
    expect(hillyWins, '…but not most').toBeLessThanOrEqual(8)
  })
})

describe('fatigue → cracking', () => {
  it('exhausted riders finish behind equally-talented fresh riders', () => {
    // same field, but every EVEN-id rider is cooked: their finish ranks should be clearly worse
    const f = buildField(makeRng(42), 18, 7)
    f.riders.forEach((r) => (r.fresh = r.id % 2 === 0 ? 55 : 100))
    let tiredRank = 0, freshRank = 0, n = 0
    for (const seed of [31, 32, 33]) {
      const out = simulate(f, SUMMIT, {}, seed, [], { frames: false })
      out.results.forEach((r) => { if (r.id % 2 === 0) tiredRank += r.place; else freshRank += r.place; n++ })
    }
    expect(tiredRank / n, 'tired half ranks worse than fresh half').toBeGreaterThan(freshRank / n * 1.15)
  })
})

describe('narrative honesty', () => {
  it('the win event names the actual winner and events carry explanations', () => {
    for (const [stage, seed] of [[FLAT, 3], [SUMMIT, 4], [HILLY, 5]]) {
      const out = run(stage, seed)
      const winEv = out.log.find((e) => e.kind === 'win')
      expect(winEv, 'win event exists').toBeTruthy()
      expect(winEv.text.startsWith(out.results[0].name), `${winEv.text} vs ${out.results[0].name}`).toBe(true)
      expect(out.explain.length, 'explanation hooks recorded').toBeGreaterThan(0)
    }
  })

  it('trace mode returns per-segment group history', () => {
    const out = simulate(field(), HILLY, {}, 6, [], { frames: false, trace: true })
    expect(Array.isArray(out.trace)).toBe(true)
    expect(out.trace.length).toBeGreaterThan(5)
    expect(out.trace[0].groups[0]).toHaveProperty('t')
  })
})

describe('playback frames', () => {
  it('frames are monotonic, bounded, and cover the whole stage', () => {
    const out = simulate(field(), SUMMIT, {}, 12, [], { frames: true })
    expect(out.frames.length).toBeGreaterThan(50)
    let last = -1
    for (const f of out.frames) {
      expect(f.leadKm).toBeGreaterThanOrEqual(last - 0.01); last = f.leadKm
      expect(f.leadKm).toBeLessThanOrEqual(SUMMIT.lengthKm + 0.01)
      expect(f.groups.length).toBeGreaterThan(0)
      expect(f.track.length).toBe(out.tracked.length)
    }
    expect(out.frames[out.frames.length - 1].leadKm).toBeGreaterThan(SUMMIT.lengthKm - 6)
  })
})
