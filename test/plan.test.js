// Season-plan logic: every rider must get a plan.
import { describe, it, expect } from 'vitest'
import { newLeague, planSeason, autoPlanUser } from '../src/gm.mjs'

const fresh = () => newLeague({ seed: 7, userTeamId: 0 })
const allRiders = (st) => st.teams.flatMap((t) => t.riderIds.map((id) => st.riders[id]).filter(Boolean))

describe('planSeason', () => {
  it('gives every rider on every team at least one target', () => {
    const st = fresh()
    planSeason(st)
    const riders = allRiders(st)
    expect(riders.length).toBeGreaterThan(0)
    const planless = riders.filter((r) => !(r.plan?.targets || []).length)
    expect(planless, `${planless.length} riders without a plan`).toHaveLength(0)
  })

  it('leaders get two well-spaced peaks, others at least one', () => {
    const st = fresh()
    planSeason(st)
    for (const r of allRiders(st)) {
      const ts = r.plan.targets
      expect(ts.length).toBeGreaterThanOrEqual(1)
      expect(ts.length).toBeLessThanOrEqual(2)
      if (ts.length === 2) {
        const w = ts.map((t) => st.calendar[t.calIndex]?.week).filter((x) => x != null)
        if (w.length === 2) expect(Math.abs(w[0] - w[1])).toBeGreaterThanOrEqual(5)
      }
      for (const t of ts) expect(st.calendar[t.calIndex]).toBeTruthy()
    }
  })
})

describe('autoPlanUser', () => {
  it('plans the whole user squad and reports the count', () => {
    const st = fresh()
    const team = st.teams[st.userTeamId]
    team.riderIds.forEach((id) => { st.riders[id].plan = { targets: [] } }) // wipe
    const n = autoPlanUser(st)
    expect(n).toBe(team.riderIds.length)
    expect(team.riderIds.every((id) => st.riders[id].plan.targets.length > 0)).toBe(true)
  })

  it('fillOnly only touches riders without a plan', () => {
    const st = fresh()
    planSeason(st)
    const team = st.teams[st.userTeamId]
    const ids = team.riderIds
    // wipe exactly two riders
    st.riders[ids[0]].plan = { targets: [] }
    st.riders[ids[1]].plan = { targets: [] }
    const before = ids.map((id) => JSON.stringify(st.riders[id].plan.targets))
    const n = autoPlanUser(st, { fillOnly: true })
    expect(n).toBe(2)
    // untouched riders keep their exact targets
    ids.forEach((id, i) => {
      if (i > 1) expect(JSON.stringify(st.riders[id].plan.targets)).toBe(before[i])
    })
    expect(st.riders[ids[0]].plan.targets.length).toBeGreaterThan(0)
  })
})
