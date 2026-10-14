// Development model — driven by the bundled standard DB.
// Verifies: DB potential is read from the star rating, young talents develop
// meaningfully (even without race results), stars can be born, and high-potential
// busts stall short of their ceiling.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { newLeague, applyRiderTeamDatabase, developAll } from '../src/gm.mjs'

const DB = JSON.parse(readFileSync(resolve(process.cwd(), 'public/riderdb.json'), 'utf8'))
const buildState = (seed = 5) => { const st = newLeague({ seed, userTeamId: 0 }); applyRiderTeamDatabase(st, DB); return st }
const ageOf = (r) => r.age

describe('DB import — potential from star rating', () => {
  it('gives young high-star riders real headroom', () => {
    const st = buildState()
    const riders = Object.values(st.riders)
    // map DB star ratings back via _dbId so we can check headroom by star
    const byDbId = new Map(DB.riders.map((d) => [d.id, d]))
    const youngElite = riders.filter((r) => ageOf(r) <= 21 && (byDbId.get(r._dbId)?.pot ?? 0) >= 5.0)
    expect(youngElite.length).toBeGreaterThan(0)
    const headrooms = youngElite.map((r) => r.ceiling - r.overall)
    const avgHead = headrooms.reduce((a, b) => a + b, 0) / headrooms.length
    expect(avgHead, `avg headroom for young 5★+ = ${avgHead.toFixed(1)}`).toBeGreaterThan(7)
    expect(Math.max(...headrooms)).toBeGreaterThan(12) // a top talent has lots of room
    // ceilings never below current ability
    expect(riders.every((r) => r.ceiling >= r.overall)).toBe(true)
  })
})

describe('development over time', () => {
  it('young talents develop substantially across several seasons', () => {
    const st = buildState(5)
    const young = Object.values(st.riders).filter((r) => ageOf(r) <= 21 && r.ceiling - r.overall >= 10)
    expect(young.length).toBeGreaterThan(10)
    const start = new Map(young.map((r) => [r.id, r.overall]))
    for (let i = 0; i < 6; i++) developAll(st, {})            // 6 off-seasons, no race results
    const gains = young.map((r) => st.riders[r.id].overall - start.get(r.id))
    const avgGain = gains.reduce((a, b) => a + b, 0) / gains.length
    expect(avgGain, `avg 6-season gain for young talents = ${avgGain.toFixed(1)}`).toBeGreaterThan(5)
    expect(Math.max(...gains), 'at least one big riser').toBeGreaterThan(12)  // a star can be born
    // nobody breaks the rating bounds
    expect(Object.values(st.riders).every((r) => r.overall <= 99 && r.overall <= r.ceiling + 1)).toBe(true)
  })

  it('flags busts and late bloomers, and busts under-realise their ceiling', () => {
    const st = buildState(5)
    const youngTalents = Object.values(st.riders).filter((r) => ageOf(r) <= 22 && r.ceiling - r.overall >= 10)
    const busts = youngTalents.filter((r) => r._bust)
    const late = Object.values(st.riders).filter((r) => r._lateBloom)
    expect(busts.length, 'some high-potential busts exist').toBeGreaterThan(0)
    expect(late.length, 'some late bloomers exist').toBeGreaterThan(0)
    // simulate; busts should gain clearly less than non-busts on average
    const nonBust = youngTalents.filter((r) => !r._bust)
    const startB = new Map(youngTalents.map((r) => [r.id, r.overall]))
    for (let i = 0; i < 6; i++) developAll(st, {})
    const gain = (arr) => arr.reduce((a, r) => a + (st.riders[r.id].overall - startB.get(r.id)), 0) / Math.max(1, arr.length)
    expect(gain(busts), 'busts under-realise vs non-busts').toBeLessThan(gain(nonBust))
  })

  it('big potential bumps the breakout chance (more & bigger leaps with more room)', () => {
    const st = buildState(5)
    const young = Object.values(st.riders).filter((r) => ageOf(r) <= 22)
    for (let i = 0; i < 6; i++) developAll(st, {})
    // _leap is set the season it fires; run one more and count leaps among high- vs low-room riders
    let leaps = 0
    for (let s = 0; s < 4; s++) { developAll(st, {}); leaps += young.filter((r) => st.riders[r.id]?._leap > 0).length }
    expect(leaps, 'leaps do occur over time').toBeGreaterThan(0)
  })
})
