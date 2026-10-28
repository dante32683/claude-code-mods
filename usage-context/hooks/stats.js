// usage-context stats: raw token use over time and what share of the weekly
// limit one 5-hour window is. Pure helpers plus the store layout; register.js
// wires them to the engine and draws them.
//
// Store layout (the plugin store is one JSON file shared by every session and
// every account, so every key names the account):
//   tok:<account>:<session id>  this session's hours, written only by it:
//                               { last, usdSeen, h: { <hour>: Bucket } }
//   toks:<account>              hours of sessions that ended, merged: { <hour>: Bucket }
//   win:<account>               one record per finished 5-hour window (see harvest)
//   merge                       { by, at }: which session is merging right now
// Bucket: { usd, m: { <model>: [input, output, cacheRead, cacheWrite, requests] } }
// <hour> is Math.floor(ms / HOUR).

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
// How long the token hours and window records are kept.
export const KEEP_HOURS_MS = 35 * DAY
export const KEEP_WINDOWS = 400
// A session's hours are merged once it has been quiet this long.
export const MERGE_AFTER_MS = 6 * HOUR
// A 5-hour window counts toward the weekly-share estimate only when it moved
// this many points, so one-point rounding of the weekly figure matters less.
export const MIN_SHARE_POINTS = 10
// How many recent windows the share and per-percent figures average over.
export const SHARE_WINDOWS = 30

export const TOK_PREFIX = 'tok:'
export const MERGED_PREFIX = 'toks:'
export const WIN_PREFIX = 'win:'
export const MERGE_KEY = 'merge'

// "claude-opus-5-5-20261001" -> "opus-5-5".
export function modelName(id) {
  return String(id || 'unknown')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
}

function bucketOf(hours, hour) {
  let b = hours[hour]
  if (!b) hours[hour] = b = { usd: 0, m: {} }
  return b
}

// Add one response's usage to the hour it arrived in.
export function addUsage(hours, nowMs, model, usage) {
  const b = bucketOf(hours, Math.floor(nowMs / HOUR))
  const name = modelName(model)
  const row = b.m[name] ?? (b.m[name] = [0, 0, 0, 0, 0])
  row[0] += usage.input_tokens || 0
  row[1] += usage.output_tokens || 0
  row[2] += usage.cache_read_input_tokens || 0
  row[3] += usage.cache_creation_input_tokens || 0
  row[4] += 1
}

// Add API-priced dollars to the hour they were measured in.
export function addCost(hours, nowMs, usd) {
  if (!(usd > 0)) return
  bucketOf(hours, Math.floor(nowMs / HOUR)).usd += usd
}

// Add every bucket of `from` into `into`.
export function mergeHours(into, from) {
  for (const [hour, b] of Object.entries(from)) {
    const t = bucketOf(into, hour)
    t.usd += b.usd || 0
    for (const [name, row] of Object.entries(b.m || {})) {
      const r = t.m[name] ?? (t.m[name] = [0, 0, 0, 0, 0])
      for (let i = 0; i < 5; i++) r[i] += row[i] || 0
    }
  }
  return into
}

// Drop hours older than the cutoff.
export function pruneHours(hours, cutoffMs) {
  const keep = Math.floor(cutoffMs / HOUR)
  for (const hour of Object.keys(hours)) if (Number(hour) < keep) delete hours[hour]
  return hours
}

export function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, usd: 0, models: {} }
}

// Totals over [fromMs, toMs) from several hour maps. An hour the range only
// partly covers counts in proportion; the current hour's span ends at `nowMs`,
// since its bucket holds only what has happened so far.
export function sumRange(maps, fromMs, toMs, nowMs) {
  const t = emptyTotals()
  // A range that runs to now takes the current hour whole.
  if (toMs >= nowMs) toMs = Infinity
  for (const hours of maps) {
    for (const [key, b] of Object.entries(hours)) {
      const start = Number(key) * HOUR
      const end = Math.min(start + HOUR, Math.max(nowMs, start + 1))
      const overlap = Math.min(end, toMs) - Math.max(start, fromMs)
      if (overlap <= 0) continue
      const f = Math.min(1, overlap / (end - start))
      t.usd += (b.usd || 0) * f
      for (const [name, row] of Object.entries(b.m || {})) {
        t.input += row[0] * f
        t.output += row[1] * f
        t.cacheRead += row[2] * f
        t.cacheWrite += row[3] * f
        t.requests += row[4] * f
        t.models[name] = (t.models[name] ?? 0) + (row[0] + row[1] + row[2] + row[3]) * f
      }
    }
  }
  return t
}

export function totalTokens(t) {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

// The value a step function of samples [[timeMs, percent], ...] (oldest first)
// holds at `atMs`: the latest sample at or before it, or null before the first.
export function valueAt(list, atMs) {
  let value = null
  for (const [t, p] of list) {
    if (t > atMs) break
    value = p
  }
  return value
}

// Samples since the figure last dropped (a reset or a plan change).
export function sinceDrop(list) {
  let start = 0
  for (let i = 1; i < list.length; i++) if (list[i][1] < list[i - 1][1] - 2) start = i
  return start === 0 ? list : list.slice(start)
}

// One record for a 5-hour window from its samples and the weekly samples:
// how far the 5-hour figure moved between its first and last sample (d5), how
// far the weekly figure moved over the same span (dw), and the figure it ended
// at (p). Null when the weekly figure is missing at either end, or the week
// reset in between.
//   five: [[timeMs, percent], ...] of the 5-hour window
//   weeks: [{ resetsAtMs, list }] of the weekly windows
export function windowRecord(resetHour, five, weeks) {
  const list = sinceDrop(five)
  if (list.length < 2) return null
  const [t0, p0] = list[0]
  const [t1, p1] = list[list.length - 1]
  const week = weeks.find((w) => t0 >= w.resetsAtMs - 7 * DAY && t1 <= w.resetsAtMs)
  if (!week) return null
  const w0 = valueAt(week.list, t0)
  const w1 = valueAt(week.list, t1)
  if (w0 === null || w1 === null || w1 < w0) return null
  return { r: resetHour, p: p1, d5: p1 - p0, dw: w1 - w0 }
}

// The share of the weekly limit one full 5-hour window is, in percent, from
// the window records: summed weekly movement over summed 5-hour movement, so
// busy windows count for more than quiet ones. Null without enough data.
export function weeklyShare(records) {
  const used = records.filter((r) => r.d5 >= MIN_SHARE_POINTS).slice(-SHARE_WINDOWS)
  const d5 = used.reduce((a, r) => a + r.d5, 0)
  const dw = used.reduce((a, r) => a + r.dw, 0)
  if (used.length === 0 || d5 <= 0) return null
  return { percent: (100 * dw) / d5, windows: used.length }
}

// Tokens and dollars per point of the 5-hour limit, from finished windows
// that logged their tokens and moved at least MIN_SHARE_POINTS.
export function perPoint(records) {
  const used = records.filter((r) => r.p >= MIN_SHARE_POINTS && r.tokens > 0).slice(-SHARE_WINDOWS)
  const points = used.reduce((a, r) => a + r.p, 0)
  if (used.length === 0 || points <= 0) return null
  return {
    tokens: used.reduce((a, r) => a + r.tokens, 0) / points,
    usd: used.reduce((a, r) => a + (r.usd || 0), 0) / points,
    windows: used.length,
  }
}

// Average end figure of finished windows seen in the last `days`.
export function averageEnd(records, nowMs, days = 30) {
  const since = (nowMs - days * DAY) / HOUR
  const used = records.filter((r) => r.r >= since)
  if (used.length === 0) return null
  return { percent: used.reduce((a, r) => a + r.p, 0) / used.length, windows: used.length }
}

// Per-day totals for the last `count` local days, newest first. `dayStart`
// gives a time's local midnight (the module reads the zone from Date).
export function dailyTotals(maps, nowMs, count, dayStart) {
  const rows = []
  let end = nowMs
  let start = dayStart(nowMs)
  for (let i = 0; i < count; i++) {
    rows.push({ start, totals: sumRange(maps, start, end, nowMs) })
    end = start
    start = dayStart(start - 1)
  }
  return rows
}

// Local midnight before `ms`.
export function localDayStart(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
