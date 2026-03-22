/**
 * Протокол: SCAN:UID → META:KEY=VALUE* → CARD_END
 * Совместимость: только SCAN (старый скетч) — сразу создаётся запись без meta.
 */

import { resolveUid } from './useRegisteredCards'

export function extractScanUid(line) {
  const t = line.trim()
  if (!t.startsWith('SCAN:')) return null
  return t.replace(/^SCAN:\s*/i, '').replace(/\s/g, '').toUpperCase()
}

export function parseMetaLine(line) {
  const t = line.trim()
  if (!t.startsWith('META:')) return null
  const rest = t.slice(5)
  const eq = rest.indexOf('=')
  if (eq <= 0) return null
  return {
    key: rest.slice(0, eq).trim(),
    value: rest.slice(eq + 1).trim(),
  }
}

/** registeredCards — из адресной книги (localStorage) */
export function buildScanRecord({ uid, meta, time, registeredCards = [] }) {
  const r = resolveUid(uid, registeredCards)
  return {
    id: Date.now() + Math.random(),
    time: time || new Date(),
    userId: r.userId,
    userName: r.userName,
    inAddressBook: r.inAddressBook,
    cardInfo: meta && Object.keys(meta).length ? meta : null,
  }
}
