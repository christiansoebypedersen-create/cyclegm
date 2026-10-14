// Finance & sponsorship: wage gap, balanced economy, sponsor model + market.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { newLeague, applyRiderTeamDatabase, valueOf, salaryOf, teamFinances,
  sponsorMarket, signSponsor, buyoutSponsor, renegotiateSponsor, labelAsk, evalAsk, openSponsorSlots, setSponsorDB, osReview } from '../src/gm.mjs'

const DB = JSON.parse(readFileSync(resolve(process.cwd(), 'public/riderdb.json'), 'utf8'))
const SPDB = JSON.parse(readFileSync(resolve(process.cwd(), 'public/sponsors.json'), 'utf8'))
afterEach(() => setSponsorDB(null))   // a failed assertion must not leak the dataset into later tests
const build = (seed = 5) => { const st = newLeague({ seed, userTeamId: 0 }); applyRiderTeamDatabase(st, DB); return st }
const mk = (ovr, age = 26) => ({ overall: ovr, age, potential: ovr, abil: {}, cp: 380, weight: 66, threshold: ovr, punch: ovr, sprint: ovr, _ovrFloor: ovr })

describe('wage gap', () => {
  it('top riders cost far more than the field', () => {
    const star = valueOf(mk(93)), solid = valueOf(mk(80)), dom = valueOf(mk(62))
    expect(star).toBeGreaterThan(8)            // a star is expensive
    expect(dom).toBeLessThan(0.6)              // a domestique is cheap
    expect(star / Math.max(0.05, dom)).toBeGreaterThan(20)  // a wide gap
    expect(salaryOf({ value: star })).toBeLessThan(star)    // salary is a fraction of value
  })
})

describe('economy balance', () => {
  it('most teams can cover wages from income (after prize/bonuses)', () => {
    const st = build()
    let underwater = 0
    for (const t of st.teams) { const f = teamFinances(st, t.id); if (f.income - f.wageBill - f.ops < -10) underwater++ }
    expect(underwater, 'few teams badly underwater on income alone').toBeLessThan(st.teams.length * 0.25)
    const f = teamFinances(st, 0)
    expect(f).toHaveProperty('wageBudget')
    expect(typeof f.net).toBe('number')
  })
})

describe('sponsor model', () => {
  it('every team has 4 sponsors with asks, values and bonuses', () => {
    const st = build()
    const f = teamFinances(st, 0)
    expect(f.sponsors.length).toBe(4)
    for (const sp of f.sponsors) {
      expect(sp.value).toBeGreaterThan(0)
      expect(sp.bonus).toBeGreaterThan(0)
      expect(labelAsk(sp.ask)).toBeTruthy()
      expect(sp.prog).toHaveProperty('met')
    }
  })

  it('evalAsk reads the season state (nationality example)', () => {
    const st = build()
    const t = st.teams[0]
    const nat = st.riders[t.riderIds[0]].nation
    const ask = { type: 'nationality', nat, pct: 1 }   // trivially met
    expect(evalAsk(st, t, ask).met).toBe(true)
    expect(evalAsk(st, t, { type: 'nationality', nat: 'ZZZ', pct: 50 }).met).toBe(false)
  })
})

describe('sponsor market + management', () => {
  it('buyout opens a slot and a market offer can be signed into it', () => {
    const st = build()
    const t = st.teams[0]
    expect(openSponsorSlots(t)).toBe(0)                 // all under contract at start
    const target = t.sponsors[1]
    const cashBefore = t.budget
    const bo = buyoutSponsor(st, 0, target.id)
    expect(bo.ok).toBe(true)
    expect(t.budget).toBeLessThan(cashBefore)           // fee paid
    expect(openSponsorSlots(t)).toBe(1)
    const offers = sponsorMarket(st, 0)
    const offer = offers.find((o) => o.tier === target.tier) || offers[0]
    const res = signSponsor(st, 0, offer.id)
    expect(res.ok).toBe(true)
    expect(openSponsorSlots(t)).toBe(0)                 // slot filled
    expect(t.sponsors.some((s) => s.name === offer.name)).toBe(true)
  })

  it('renegotiating is blocked while under contract, allowed when expired', () => {
    const st = build()
    const t = st.teams[0]
    expect(renegotiateSponsor(st, 0, t.sponsors[0].id).ok).toBe(false)  // under contract
    t.sponsors[0].years = 0
    const r = renegotiateSponsor(st, 0, t.sponsors[0].id)
    expect(r.ok).toBe(true)
    expect(t.sponsors[0].years).toBeGreaterThan(0)      // renewed
  })
})

describe('sponsor dataset (600 companies)', () => {
  it('co-sponsors are paid far less than the title sponsor', () => {
    setSponsorDB(SPDB)
    const st = newLeague({ seed: 3, userTeamId: 0, sponsorDB: SPDB })
    let titleOver = 0, total = 0
    for (const t of st.teams) {
      const title = t.sponsors.find((s) => s.tier === 'title')
      const cos = t.sponsors.filter((s) => s.tier !== 'title')
      if (!title || !cos.length) continue
      total++
      const maxCo = Math.max(...cos.map((s) => s.value))
      if (title.value > maxCo * 1.3) titleOver++      // title clearly outpays every co-sponsor
    }
    expect(total).toBeGreaterThan(0)
    expect(titleOver / total, 'title outpays co-sponsors on almost every team').toBeGreaterThan(0.9)
    setSponsorDB(null)
  })

  it('cannot sign a second title sponsor — the title slot is enforced', () => {
    setSponsorDB(SPDB)
    const st = newLeague({ seed: 4, userTeamId: 0, sponsorDB: SPDB })
    const t = st.teams[0]
    expect(t.sponsors.filter((s) => s.tier === 'title').length).toBe(1)
    const coSlot = t.sponsors.find((s) => s.tier === 'co')
    buyoutSponsor(st, 0, coSlot.id)                    // free a CO slot, title still contracted
    const titleOffer = sponsorMarket(st, 0).find((o) => o.tier === 'title')
    expect(titleOffer).toBeTruthy()
    const res = signSponsor(st, 0, titleOffer.id)
    expect(res.ok).toBe(false)                          // no open title slot → refused
    expect(t.sponsors.filter((s) => s.tier === 'title' && !s.vacant).length).toBe(1)  // still exactly one
    setSponsorDB(null)
  })

  it('a sponsor walks when its target is missed past patience (title walkout renames + hits the board)', () => {
    setSponsorDB(SPDB)
    const st = newLeague({ seed: 4, userTeamId: 0, sponsorDB: SPDB })
    st.objective = { rankTarget: 1, winsTarget: 1, tier: st.teams[0].tier, text: 'x', season: st.season }
    const t = st.teams[0]
    const title = t.sponsors.find((s) => s.tier === 'title')
    title.ask = { type: 'nationality', nat: 'ZZZ', pct: 99 }   // impossible to meet
    title.patience = 1; title.happy = false
    const beforeName = t.name, beforeConf = st.boardConfidence ?? 62
    osReview(st)                                         // settles finances → miss → patience 0 → walk
    const titleSlot = t.sponsors.find((s) => s.tier === 'title')
    expect(titleSlot.vacant).toBe(true)                 // slot now empty
    expect(st.boardConfidence).toBeLessThan(beforeConf) // board hit
    expect(t.name).not.toBe(beforeName)                 // team renamed (lost its title)
    setSponsorDB(null)
  })

  it('signing a new title sponsor renames the team', () => {
    setSponsorDB(SPDB)
    const st = newLeague({ seed: 3, userTeamId: 0, sponsorDB: SPDB })
    const t = st.teams[0]
    const titleSp = t.sponsors.find((s) => s.tier === 'title')
    buyoutSponsor(st, 0, titleSp.id)                   // free the title slot
    const offers = sponsorMarket(st, 0)
    const titleOffer = offers.find((o) => o.tier === 'title')
    expect(titleOffer).toBeTruthy()
    const before = t.name
    const res = signSponsor(st, 0, titleOffer.id)
    expect(res.ok).toBe(true)
    expect(t.name).not.toBe(before)                    // renamed
    expect(t.name).toContain(titleOffer.name)          // named after the new title sponsor
    setSponsorDB(null)
  })
})
