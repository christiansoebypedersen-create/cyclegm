// Logic tests for the new scouting helpers: recommended regions + auto-assign.
import { describe, it, expect } from 'vitest'
import { newLeague, regionOpportunities, autoAssignScouts, bestIdleScout,
  sendBestIdleScout, userScouts } from '../src/gm.mjs'

const fresh = () => newLeague({ seed: 42, userTeamId: 0 })

describe('regionOpportunities', () => {
  it('scores every region and recommends up to 3 unstaffed ones', () => {
    const st = fresh()
    const opps = regionOpportunities(st)
    expect(opps.length).toBeGreaterThan(0)
    for (const o of opps) {
      expect(o).toHaveProperty('score')
      expect(o.score).toBeGreaterThanOrEqual(0)
      expect(o.know).toBeGreaterThanOrEqual(0)
    }
    // sorted by score desc
    for (let i = 1; i < opps.length; i++) expect(opps[i - 1].score).toBeGreaterThanOrEqual(opps[i].score)
    const recs = opps.filter((o) => o.recommended)
    expect(recs.length).toBeGreaterThan(0)
    expect(recs.length).toBeLessThanOrEqual(3)
    recs.forEach((r) => { expect(r.staffed).toBe(false); expect(r.reason).toBeTruthy() })
  })

  it('excludes already-staffed regions from recommendations', () => {
    const st = fresh()
    const sc = userScouts(st)[0]
    expect(sc).toBeTruthy()
    const target = regionOpportunities(st).find((o) => o.recommended)
    sc.assign = { type: 'region', region: target.key }
    const after = regionOpportunities(st)
    const staffedRow = after.find((o) => o.key === target.key)
    expect(staffedRow.staffed).toBe(true)
    expect(staffedRow.recommended).toBe(false)
    expect(after.filter((o) => o.recommended).every((o) => o.key !== target.key)).toBe(true)
  })
})

describe('autoAssignScouts', () => {
  it('deploys every idle scout to a distinct region without double-stacking', () => {
    const st = fresh()
    userScouts(st).forEach((s) => { s.assign = null }) // make all idle
    const idle = userScouts(st).length
    expect(idle).toBeGreaterThan(0)
    const report = autoAssignScouts(st)
    expect(report.length).toBe(idle)                    // all idle scouts placed
    const regions = report.map((r) => r.region)
    expect(new Set(regions).size).toBe(regions.length)  // no double-stack while regions remain
    expect(userScouts(st).every((s) => s.assign && s.assign.type === 'region')).toBe(true)
  })

  it('assigns highest-JPP scout to the highest-opportunity region', () => {
    const st = fresh()
    userScouts(st).forEach((s) => { s.assign = null })
    const topJpp = userScouts(st).slice().sort((a, b) => b.jpp - a.jpp)[0]
    const topOpp = regionOpportunities(st).filter((o) => !o.staffed && o.score > 0)[0]
    const report = autoAssignScouts(st)
    const placed = report.find((r) => r.scoutId === topJpp.id)
    expect(placed.region).toBe(topOpp.key)
  })

  it('returns an empty report when there are no idle scouts', () => {
    const st = fresh()
    userScouts(st).forEach((s) => { s.assign = { type: 'region', region: 'central' } })
    expect(autoAssignScouts(st)).toEqual([])
  })
})

describe('bestIdleScout / sendBestIdleScout', () => {
  it('picks the highest-JPP idle scout', () => {
    const st = fresh()
    userScouts(st).forEach((s) => { s.assign = null })
    const expected = userScouts(st).slice().sort((a, b) => b.jpp - a.jpp)[0]
    expect(bestIdleScout(st).id).toBe(expected.id)
  })

  it('sends the best idle scout to the requested region', () => {
    const st = fresh()
    userScouts(st).forEach((s) => { s.assign = null })
    const sc = sendBestIdleScout(st, 'iberia')
    expect(sc).toBeTruthy()
    expect(userScouts(st).find((s) => s.id === sc.id).assign).toEqual({ type: 'region', region: 'iberia' })
  })

  it('falls back to an assigned scout when none are idle', () => {
    const st = fresh()
    userScouts(st).forEach((s) => { s.assign = { type: 'region', region: 'france' } })
    expect(bestIdleScout(st)).toBeTruthy() // fallback, not null
  })
})
