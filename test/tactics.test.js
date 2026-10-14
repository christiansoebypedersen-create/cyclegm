// Pre-race tactics: smart recommendation + setup warnings.
import { describe, it, expect } from 'vitest'
import { newLeague, recommendTactics, recommendStagePlan, tacticWarnings } from '../src/gm.mjs'

const fresh = () => newLeague({ seed: 11, userTeamId: 0 })

describe('recommendTactics', () => {
  it('returns a full, internally-consistent setup for the next race', () => {
    const st = fresh()
    const race = st.calendar[0]
    const rec = recommendTactics(st, race)
    const size = race.kind === 'tour' ? 8 : 7
    expect(rec.riderIds.length).toBeGreaterThan(0)
    expect(rec.riderIds.length).toBeLessThanOrEqual(size)
    // leader is set and is among the selected riders
    expect(rec.leaderId).toBe(rec.riderIds[0])
    expect(rec.duties[rec.leaderId]).toBe('leader')
    // exactly one leader
    expect(Object.values(rec.duties).filter((d) => d === 'leader')).toHaveLength(1)
    // one stage plan per stage, leader protected, valid plan keys
    expect(rec.stagePlans.length).toBe(race.stages.length)
    for (const sp of rec.stagePlans) {
      expect(['control', 'gc', 'breakaway', 'auto']).toContain(sp.plan)
      expect(sp.protect).toContain(rec.leaderId)
      if (sp.sprinterLid != null) expect(rec.riderIds).toContain(sp.sprinterLid)
    }
  })

  it('only sets a sprinter on bunch-finish stages', () => {
    const st = fresh()
    const race = st.calendar.find((r) => r.kind === 'tour') || st.calendar[0]
    const rec = recommendTactics(st, race)
    rec.stagePlans.forEach((sp, i) => {
      const ft = race.stages[i].finishType
      if (sp.sprinterLid != null) expect(ft === 'flat' || ft === 'hilly').toBe(true)
    })
  })
})

describe('recommendStagePlan', () => {
  it('suggests a valid single-stage plan honouring the passed squad/leader', () => {
    const st = newLeague({ seed: 11, userTeamId: 0 })
    const race = st.calendar.find((r) => r.kind === 'tour') || st.calendar[0]
    const rec = recommendTactics(st, race)
    const sp = recommendStagePlan(st, race, 0, { riderIds: rec.riderIds, leaderId: rec.leaderId })
    expect(sp).toBeTruthy()
    expect(['control', 'gc', 'breakaway', 'auto']).toContain(sp.plan)
    expect(sp.protect).toContain(rec.leaderId)
    if (sp.sprinterLid != null) {
      expect(rec.riderIds).toContain(sp.sprinterLid)
      const ft = race.stages[0].finishType
      expect(ft === 'flat' || ft === 'hilly').toBe(true)
    }
  })

  it('matches the full recommender stage-for-stage', () => {
    const st = newLeague({ seed: 11, userTeamId: 0 })
    const race = st.calendar.find((r) => r.kind === 'tour') || st.calendar[0]
    const rec = recommendTactics(st, race)
    rec.stagePlans.forEach((full, i) => {
      const one = recommendStagePlan(st, race, i, { riderIds: rec.riderIds, leaderId: rec.leaderId })
      expect(one.plan).toBe(full.plan)
      expect(one.sprinterLid).toBe(full.sprinterLid)
    })
  })

  it('returns null for an out-of-range stage', () => {
    const st = newLeague({ seed: 11, userTeamId: 0 })
    expect(recommendStagePlan(st, st.calendar[0], 999, {})).toBeNull()
  })
})

describe('tacticWarnings', () => {
  it('flags an empty / wrong-size squad', () => {
    const st = fresh()
    const race = st.calendar[0]
    const w = tacticWarnings(st, race, { riderIds: [], leaderId: null, stagePlans: [] })
    expect(w.some((x) => x.level === 'warn' && /Select \d+ riders/.test(x.text))).toBe(true)
    expect(w.some((x) => /No leader/.test(x.text))).toBe(true)
  })

  it('a recommended setup raises no blocking warnings about squad size or leader', () => {
    const st = fresh()
    const race = st.calendar[0]
    const rec = recommendTactics(st, race)
    const w = tacticWarnings(st, race, { riderIds: rec.riderIds, leaderId: rec.leaderId, stagePlans: rec.stagePlans })
    expect(w.some((x) => /Select \d+ riders/.test(x.text))).toBe(false)
    expect(w.some((x) => /No leader/.test(x.text))).toBe(false)
  })

  it('warns when controlling for a sprint with no sprinter', () => {
    const st = fresh()
    const race = st.calendar[0]
    const flatIdx = race.stages.findIndex((s) => s.finishType === 'flat' || s.finishType === 'hilly')
    if (flatIdx < 0) return // some calendars may have no bunch finish in race 0
    const rec = recommendTactics(st, race)
    rec.stagePlans[flatIdx] = { ...rec.stagePlans[flatIdx], plan: 'control', sprinterLid: null }
    const w = tacticWarnings(st, race, { riderIds: rec.riderIds, leaderId: rec.leaderId, stagePlans: rec.stagePlans })
    expect(w.some((x) => /no sprinter set/.test(x.text))).toBe(true)
  })
})
