import { useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'rfid-dashboard-cards-v1'

function avatarFromName(name) {
  const t = (name || '?').trim()
  if (t.length >= 2) return t.slice(0, 2).toUpperCase()
  return (t[0] || '?').toUpperCase()
}

export function loadCards() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export function saveCards(cards) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cards))
}

export function useRegisteredCards() {
  const [cards, setCards] = useState(() => loadCards())

  useEffect(() => {
    saveCards(cards)
  }, [cards])

  const addCard = useCallback((uid, name, note = '') => {
    const id = String(uid).replace(/\s/g, '').toUpperCase()
    if (!id || id.length < 4) return { ok: false, error: 'Некорректный UID (мин. 4 hex-символа)' }
    const nm = (name || 'Без имени').trim()
    let added = false
    setCards((prev) => {
      if (prev.some((c) => c.id === id)) return prev
      added = true
      return [
        ...prev,
        {
          id,
          name: nm,
          note: String(note || '').trim(),
          avatar: avatarFromName(nm),
          addedAt: new Date().toISOString(),
        },
      ]
    })
    return added ? { ok: true } : { ok: false, error: 'Эта карта уже в списке' }
  }, [])

  const updateCard = useCallback((id, patch) => {
    setCards((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const name = patch.name != null ? String(patch.name).trim() : c.name
        return {
          ...c,
          ...patch,
          name,
          avatar: patch.name != null ? avatarFromName(name) : c.avatar,
        }
      }),
    )
  }, [])

  const removeCard = useCallback((id) => {
    setCards((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const replaceAll = useCallback((next) => {
    setCards(Array.isArray(next) ? next : [])
  }, [])

  return { cards, setCards, addCard, updateCard, removeCard, replaceAll }
}

/** UID → подпись из списка (без «доступ/отказ» — только факт в списке или нет) */
export function resolveUid(uid, registeredCards) {
  const up = String(uid).replace(/\s/g, '').toUpperCase()
  const row = registeredCards.find((c) => c.id === up)
  if (row) {
    return {
      userId: up,
      userName: row.name,
      avatar: row.avatar,
      inAddressBook: true,
      note: row.note || '',
    }
  }
  return {
    userId: up,
    userName: 'Без подписи',
    avatar: '?',
    inAddressBook: false,
    note: '',
  }
}
