// Off-season storytelling data contract (the UI renders these shapes).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { newLeague, applyRiderTeamDatabase, seasonStory, osDevelop, osTransfers } from '../src/gm.mjs'

const DB = JSON.parse(readFileSync(resolve(process.cwd(), 'public/riderdb.json'), 'utf8'))
const build = (seed = 9) => { const st = newLeague({ seed, userTeamId: 0 }); applyRiderTeamDatabase(st, DB); return st }

describe('seasonStory', () => {
  it('produces a recap, peloton state and awards from the rankings', () => {
    const st = build()
    // seed a believable end-of-season ranking
    const ut = st.teams[st.userTeamId]
    const mine = ut.riderIds.slice(0, 3)
    const rivalTeam = st.teams.find((t) => t.id !== st.userTeamId)
    const rivalRider = st.teams[rivalTeam.id].riderIds[0]
    st.rankings.rider[rivalRider] = 900
    st.rankings.rider[mine[0]] = 600
    st.rankings.rider[mine[1]] = 300
    st.rankings.team[rivalTeam.id] = 1500
    st.rankings.team[st.userTeamId] = 800

    const story = seasonStory(st, { verdict: 'met', text: 'Top 10 finish', rank: 4, wins: 3, confidence: 60, delta: 2 })
    expect(story.season).toBe(st.season)
    expect(Array.isArray(story.recap) && story.recap.length).toBeGreaterThan(1)
    expect(story.topTeams.length).toBeGreaterThan(0)
    expect(story.topRiders[0].lid).toBe(rivalRider)      // highest points = rider of the year
    const titles = story.awards.map((a) => a.title)
    expect(titles.some((t) => /Rider of the Year/.test(t))).toBe(true)
    expect(titles.some((t) => /Team of the Year/.test(t))).toBe(true)
    expect(story.awards.find((a) => /MVP/.test(a.title)).lid).toBe(mine[0]) // your top scorer
    // the user's MVP belongs to the user team
    expect(st.riders[story.team.mvpLid].teamId).toBe(st.userTeamId)
  })
})

describe('osDevelop movers', () => {
  it('returns the winter-movers arrays the story step renders', () => {
    const st = build()
    const d = osDevelop(st, {})
    for (const k of ['report', 'risers', 'fallers', 'lateBlooms', 'stalled', 'leagueBreakouts']) {
      expect(Array.isArray(d[k]), `${k} is an array`).toBe(true)
    }
    // risers are sorted by delta desc and only include real gains
    d.risers.forEach((m) => expect(m.delta).toBeGreaterThanOrEqual(3))
    for (let i = 1; i < d.risers.length; i++) expect(d.risers[i - 1].delta).toBeGreaterThanOrEqual(d.risers[i].delta)
  })
})

describe('osTransfers tributes', () => {
  it('builds career tributes for retirees', () => {
    const st = build()
    // force several veterans to the brink so retirement fires
    const olds = Object.values(st.riders).filter((r) => r.teamId != null).slice(0, 12)
    olds.forEach((r) => { r.age = 42; r.career = { wins: 30, podiums: 40, seasons: 15, top10: 80, points: 500 } })
    const tr = osTransfers(st)
    expect(Array.isArray(tr.tributes)).toBe(true)
    expect(Array.isArray(tr.moves)).toBe(true)
    expect(tr.tributes.length).toBeGreaterThan(0)
    const t = tr.tributes[0]
    expect(t).toHaveProperty('name')
    expect(t).toHaveProperty('seasons')
    expect(['great', 'stalwart', 'journeyman']).toContain(t.tier)
    // sorted by career wins desc
    for (let i = 1; i < tr.tributes.length; i++) expect(tr.tributes[i - 1].wins).toBeGreaterThanOrEqual(tr.tributes[i].wins)
  })
})
