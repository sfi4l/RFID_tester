import { useState, useEffect, useCallback, useRef } from 'react'
import { appendSerialChunk, encodeAsciiLine } from './utils/serialBytes'
import {
  extractScanUid,
  parseMetaLine,
  buildScanRecord,
} from './cardSerialProtocol'
import { useRegisteredCards, resolveUid } from './useRegisteredCards'
import {
  WifiOff,
  Clock,
  ScanLine,
  Users,
  Key,
  Sparkles,
  ChevronRight,
  CreditCard,
  Cpu,
  X,
  Plus,
  Trash2,
  BookUser,
  Pencil,
  Palette,
  SunMedium,
} from 'lucide-react'

/** Примеры для кнопки «Загрузить примеры» */
const SEED_EXAMPLES = [
  { id: 'A1B2C3D4', name: 'Иван Петров', note: 'Пример' },
  { id: 'E5F6G7H8', name: 'Мария Сидорова', note: '' },
  { id: 'I9J0K1L2', name: 'Алексей Козлов', note: '' },
  { id: 'M3N4O5P6', name: 'Елена Новикова', note: '' },
]

const LED_SWATCHES = ['#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ef4444', '#f59e0b']

function formatTime(date) {
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatDate(date) {
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function hexToRgb(hex) {
  const normalized = hex.replace('#', '').trim()
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return { r: 0, g: 0, b: 0 }
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  }
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

function applyBrightness(hex, brightness) {
  const ratio = Math.max(0, Math.min(100, Number(brightness))) / 100
  const { r, g, b } = hexToRgb(hex)
  return rgbToHex({ r: r * ratio, g: g * ratio, b: b * ratio })
}

export default function App() {
  const [time, setTime] = useState(new Date())
  const [deviceOnline, setDeviceOnline] = useState(false)
  const [scans, setScans] = useState([])
  const [totalScans, setTotalScans] = useState(0)
  const [uniqueUsers, setUniqueUsers] = useState(new Set())
  const [lastScan, setLastScan] = useState(null)
  const [serialPort, setSerialPort] = useState(null)
  const [reader, setReader] = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [baudRate, setBaudRate] = useState(9600)
  const [deviceReady, setDeviceReady] = useState(false)
  const [writeStatus, setWriteStatus] = useState(null)  // null | 'waiting' | 'ok' | 'err'
  const [cardLabel, setCardLabel] = useState('REGISTERED')
  const [selectedScan, setSelectedScan] = useState(null)
  const [ledHex, setLedHex] = useState('#22c55e')
  const [ledBrightness, setLedBrightness] = useState(90)
  const [ledStatus, setLedStatus] = useState(null) // null | 'sending' | 'ok' | 'err'
  const pendingScanRef = useRef(null)
  const metaFlushTimerRef = useRef(null)
  const cardsRef = useRef([])
  const { cards, addCard, updateCard, removeCard, replaceAll } = useRegisteredCards()

  useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  // Clock update
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Parse incoming serial data (Arduino RFID formats)
  // Поддерживаемые форматы: "SCAN: A1B2C3D4", "Card UID: A1 B2 C3 D4", "UID: A1B2C3D4"
  const parseSerialLine = useCallback((line) => {
    const trimmed = line.trim()
    if (!trimmed) return null

    let cardId = null

    // SCAN:/META:/CARD_END — в processIncomingData
    if (trimmed.startsWith('SCAN:')) return null
    if (trimmed.startsWith('META:') || trimmed === 'CARD_END') return null

    // Форматы MFRC522: "Card UID: A1 B2 C3 D4" или "A1 B2 C3 D4"
    const hexTokens = trimmed.match(/\b[0-9A-Fa-f]{2}\b/g)
    if (hexTokens && hexTokens.length >= 2) {
      cardId = hexTokens.join('').toUpperCase()
    } else {
      const afterUid = trimmed.replace(/^.*(?:UID|Card)[:\s]*/i, '').replace(/\s/g, '')
      if (/^[0-9A-Fa-f]{4,}$/i.test(afterUid)) cardId = afterUid.toUpperCase()
    }

    if (!cardId || cardId.length < 4) return null

    const r = resolveUid(cardId, cardsRef.current)

    return {
      id: Date.now() + Math.random(),
      time: new Date(),
      userId: r.userId,
      userName: r.userName,
      inAddressBook: r.inAddressBook,
      cardInfo: null,
    }
  }, [])

  // Web Serial API - connect to Arduino
  const connectSerial = async () => {
    if (!navigator.serial) {
      alert('Web Serial API не поддерживается. Используй Chrome или Edge.')
      return
    }

    setConnecting(true)
    try {
      // Сначала закрываем старый порт, если был (избегаем "already open")
      if (serialPort) {
        try {
          await serialPort.close()
        } catch (_) {}
        setReader(null)
        setSerialPort(null)
        await new Promise((r) => setTimeout(r, 500))
      }

      const port = await navigator.serial.requestPort()
      await port.open({ baudRate })

      setSerialPort(port)
      setDeviceOnline(true)

      // Читаем СРАЗУ после open(). Раньше была пауза до pipeTo — буфер Serial
      // переполнялся, Arduino блокировался на Serial.print, поток рвался.
      const reader = port.readable.getReader()
      setReader(reader)

      const pushScanRecord = (scan) => {
        setScans((s) => [scan, ...s].slice(0, 50))
        setTotalScans((n) => n + 1)
        setUniqueUsers((u) => new Set([...u, scan.userId]))
        setLastScan(scan)
        setSelectedScan(scan)
      }

      const processIncomingData = (line) => {
        const t = line.trim()
        if (!t) return
        if (t === 'SYSTEM_READY') {
          setDeviceReady(true)
          return
        }
        if (t === 'PING') return
        if (t === 'WRITE_OK') {
          setWriteStatus('ok')
          setTimeout(() => setWriteStatus(null), 3000)
          return
        }
        if (t.startsWith('WRITE_ERR')) {
          setWriteStatus('err')
          setTimeout(() => setWriteStatus(null), 4000)
          return
        }

        if (t === 'CARD_END') {
          clearTimeout(metaFlushTimerRef.current)
          if (pendingScanRef.current) {
            const scan = buildScanRecord({
              uid: pendingScanRef.current.uid,
              meta: pendingScanRef.current.meta,
              time: pendingScanRef.current.time,
              registeredCards: cardsRef.current,
            })
            pendingScanRef.current = null
            pushScanRecord(scan)
          }
          return
        }

        const metaParsed = parseMetaLine(t)
        if (metaParsed && pendingScanRef.current) {
          pendingScanRef.current.meta[metaParsed.key] = metaParsed.value
          return
        }

        const uidFromScan = extractScanUid(t)
        if (uidFromScan) {
          pendingScanRef.current = {
            uid: uidFromScan,
            meta: {},
            time: new Date(),
          }
          clearTimeout(metaFlushTimerRef.current)
          metaFlushTimerRef.current = setTimeout(() => {
            if (pendingScanRef.current) {
              const scan = buildScanRecord({
                uid: pendingScanRef.current.uid,
                meta: pendingScanRef.current.meta,
                time: pendingScanRef.current.time,
                registeredCards: cardsRef.current,
              })
              pendingScanRef.current = null
              pushScanRecord(scan)
            }
          }, 500)
          return
        }

        const scan = parseSerialLine(line)
        if (scan) pushScanRecord(scan)
      }

      const readLoop = async () => {
        let partialLine = ''

        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break

            partialLine = appendSerialChunk(partialLine, value)
            const lines = partialLine.split(/\r?\n/)
            partialLine = lines.pop() || ''

            lines.forEach((line) => {
              const cleanLine = line.trim()
              if (cleanLine) processIncomingData(cleanLine)
            })
          }
        } catch (err) {
          if (err.name !== 'NetworkError') console.error('Ошибка при чтении:', err)
        } finally {
          try {
            const tail = partialLine.trim()
            if (tail) processIncomingData(tail)
          } catch (_) {}
          reader.releaseLock()
          try {
            await port.close()
          } catch (_) {}
          setDeviceOnline(false)
          setDeviceReady(false)
          setReader(null)
          setSerialPort(null)
        }
      }

      readLoop()
    } catch (err) {
      console.error(err)
      if (err.name !== 'NotFoundError') {
        const msg = err.message || ''
        const tips = msg.toLowerCase().includes('open') || msg.toLowerCase().includes('failed')
          ? '\n\nПопробуй:\n• Закрой Serial Monitor в Arduino IDE\n• Нажми «Отключить», подожди 3 сек, подключи снова\n• Отключи и снова подключи Arduino по USB\n• Serial.begin(' + baudRate + ') в скетче'
          : ''
        alert('Не удалось подключиться к порту: ' + (msg || 'Неизвестная ошибка') + tips)
      }
    } finally {
      setConnecting(false)
    }
  }

  // Отправка команды в Arduino
  const sendToArduino = async (text) => {
    if (!serialPort?.writable) return false
    try {
      const writer = serialPort.writable.getWriter()
      await writer.write(encodeAsciiLine(text))
      writer.releaseLock()
      return true
    } catch (e) {
      console.error('Send to Arduino:', e)
      return false
    }
  }

  // Запись на карту (формат: sector 1, block 1, 16 байт)
  const writeToCard = async () => {
    if (!deviceOnline) return
    setWriteStatus('waiting')
    const str = (cardLabel || 'REGISTERED').padEnd(16, '\0').slice(0, 16)
    const hex = [...str].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    const sent = await sendToArduino(`WRITE:1:1:${hex}`)
    if (!sent) setWriteStatus(null)
  }

  const sendRgbColor = async (hex = ledHex, brightness = ledBrightness) => {
    if (!deviceOnline) return
    setLedStatus('sending')
    const effectiveHex = applyBrightness(hex, brightness)
    const sent = await sendToArduino(`RGB:${effectiveHex.slice(1).toUpperCase()}`)
    if (!sent) {
      setLedStatus('err')
      setTimeout(() => setLedStatus(null), 3000)
      return
    }
    setLedStatus('ok')
    setTimeout(() => setLedStatus(null), 2000)
  }

  const sendRgbAuto = async () => {
    if (!deviceOnline) return
    setLedStatus('sending')
    const sent = await sendToArduino('RGB:AUTO')
    if (!sent) {
      setLedStatus('err')
      setTimeout(() => setLedStatus(null), 3000)
      return
    }
    setLedStatus('ok')
    setTimeout(() => setLedStatus(null), 2000)
  }

  // Disconnect serial
  const disconnectSerial = async () => {
    if (reader) {
      try {
        await reader.cancel()
      } catch (_) {}
    }
    if (serialPort) {
      try {
        await serialPort.close()
      } catch (_) {}
    }
    setReader(null)
    setSerialPort(null)
    setDeviceOnline(false)
    setDeviceReady(false)
  }

  const addDemoScan = () => {
    const ex = SEED_EXAMPLES[Math.floor(Math.random() * SEED_EXAMPLES.length)]
    const scan = buildScanRecord({
      uid: ex.id,
      meta: {
        PICC_TYPE_ID: '8',
        PICC_TYPE_NAME: 'MIFARE 1KB',
        UID_LEN_BYTES: '4',
        UID_RAW: ex.id,
        SAK: '08',
        MEM_KB_HINT: '1',
        SECTOR0_AUTH: 'OK_KEY_A',
        BLK_S0_0: '04' + ex.id.slice(0, 12) + '000000',
        BLK_S0_1: '00000000000000000000000000000000',
        BLK_S0_2: '00000000000000000000000000000000',
        NOTE: 'Демо (без Arduino)',
      },
      time: new Date(),
      registeredCards: cardsRef.current,
    })
    setScans((s) => [scan, ...s].slice(0, 50))
    setTotalScans((n) => n + 1)
    setUniqueUsers((u) => new Set([...u, scan.userId]))
    setLastScan(scan)
    setSelectedScan(scan)
  }

  const seedExampleCards = () => {
    replaceAll(
      SEED_EXAMPLES.map((e) => ({
        id: e.id,
        name: e.name,
        note: e.note,
        avatar: e.name.slice(0, 2).toUpperCase(),
        addedAt: new Date().toISOString(),
      })),
    )
  }

  const [newUid, setNewUid] = useState('')
  const [newName, setNewName] = useState('')
  const [newNote, setNewNote] = useState('')
  const [editingCardId, setEditingCardId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editNote, setEditNote] = useState('')

  const handleAddCard = () => {
    const r = addCard(newUid, newName, newNote)
    if (r.ok) {
      setNewUid('')
      setNewName('')
      setNewNote('')
    } else alert(r.error || 'Не удалось добавить')
  }

  const handleAddFromScan = (scan, name, note) => {
    const r = addCard(scan.userId, name, note)
    if (r.ok) {
      setSelectedScan(null)
    } else alert(r.error || 'Не удалось')
  }

  const effectiveLedHex = applyBrightness(ledHex, ledBrightness)

  return (
    <div className="app-root min-h-screen font-sans text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_120%_80%_at_50%_-20%,rgba(139,92,246,0.18),transparent_50%),radial-gradient(ellipse_80%_50%_at_100%_50%,rgba(245,158,11,0.06),transparent_45%)]" />
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#090b0f]/85 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/30 to-amber-500/10 ring-1 ring-white/10">
              <CreditCard className="h-6 w-6 text-violet-300" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white sm:text-xl">
                RFID Desk
              </h1>
              <p className="text-xs text-zinc-500">Консоль сканирования и список карт</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.04] px-3 py-2">
              {deviceOnline ? (
                <>
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
                  <span className="text-sm text-zinc-300">
                    {deviceReady ? 'Ридер готов' : 'Связь есть'}
                  </span>
                </>
              ) : (
                <>
                  <WifiOff className="h-4 w-4 text-zinc-500" />
                  <span className="text-sm text-zinc-500">Нет связи</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.04] px-3 py-2">
              <Clock className="h-4 w-4 text-amber-400/90" />
              <span className="font-mono text-sm tabular-nums text-zinc-300">
                {formatTime(time)}
              </span>
            </div>
            {navigator.serial ? (
              deviceOnline ? (
                <button
                  type="button"
                  onClick={disconnectSerial}
                  className="btn-ghost border-rose-500/25 text-rose-300 hover:bg-rose-500/10"
                >
                  Отключить
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={baudRate}
                    onChange={(e) => setBaudRate(Number(e.target.value))}
                    className="input-select cursor-pointer rounded-xl border border-white/[0.08] bg-zinc-900/90 px-3 py-2 text-sm text-zinc-200"
                    title="Скорость Serial"
                  >
                    <option value={9600}>9600</option>
                    <option value={57600}>57600</option>
                    <option value={115200}>115200</option>
                  </select>
                  <button
                    type="button"
                    onClick={connectSerial}
                    disabled={connecting}
                    className="btn-primary disabled:cursor-not-allowed"
                  >
                    {connecting ? 'Подключение…' : 'Подключить'}
                  </button>
                </div>
              )
            ) : (
              <span className="rounded-lg bg-amber-500/10 px-2 py-1 text-xs text-amber-200/90">
                Нужен Chrome / Edge
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Stat Cards */}
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={ScanLine}
            label="Сканирований"
            value={totalScans}
            accent="violet"
          />
          <StatCard
            icon={Users}
            label="Уникальных UID"
            value={uniqueUsers.size}
            accent="amber"
          />
          <StatCard
            icon={Sparkles}
            label="Последнее сканирование"
            value={lastScan ? lastScan.userName : '—'}
            sub={lastScan?.userId}
            accent="violet"
            pulse
          />
          <StatCard
            icon={BookUser}
            label="Карт в списке"
            value={cards.length}
            accent="amber"
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Live Feed */}
          <div className="lg:col-span-2">
            <GlassCard>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/15 ring-1 ring-violet-400/20">
                      <ScanLine className="h-5 w-5 text-violet-300" />
                    </span>
                    Лента сканирований
                  </h2>
                  <p className="mt-1 text-xs text-zinc-500">
                    Клик по строке — карточка с подробностями
                  </p>
                </div>
                <button type="button" onClick={addDemoScan} className="btn-secondary text-xs">
                  <Sparkles className="h-3.5 w-3.5 text-amber-400/90" />
                  Демо-событие
                </button>
              </div>
              <div className="max-h-[420px] overflow-y-auto rounded-xl ring-1 ring-white/[0.04]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-[1] bg-zinc-950/95 backdrop-blur-md">
                    <tr className="text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      <th className="px-4 py-3">Время</th>
                      <th className="px-4 py-3">Подпись / UID</th>
                      <th className="px-4 py-3">Список</th>
                      <th className="px-4 py-3">META</th>
                      <th className="px-4 py-3 text-right"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-14 text-center">
                          <p className="text-sm text-zinc-500">
                            Пока пусто. Подключите ридер или нажмите «Демо-событие».
                          </p>
                        </td>
                      </tr>
                    ) : (
                      scans.map((scan) => (
                        <tr
                          key={scan.id}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setSelectedScan(scan)
                            }
                          }}
                          onClick={() => setSelectedScan(scan)}
                          className={`cursor-pointer border-t border-white/[0.05] transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.06] focus-visible:outline-none ${
                            selectedScan?.id === scan.id
                              ? 'bg-violet-500/[0.09]'
                              : ''
                          }`}
                        >
                          <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-zinc-400">
                            {formatDate(scan.time)}
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-medium text-zinc-100">{scan.userName}</span>
                            <span className="mt-0.5 block font-mono text-[11px] text-zinc-500">
                              {scan.userId}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide ${
                                scan.inAddressBook
                                  ? 'bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/25'
                                  : 'bg-zinc-800/90 text-zinc-400 ring-1 ring-white/[0.06]'
                              }`}
                            >
                              {scan.inAddressBook ? 'В списке' : 'Нет в списке'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {scan.cardInfo ? (
                              <span className="inline-flex rounded-lg bg-amber-500/12 px-2 py-1 text-[11px] font-medium text-amber-200/95 ring-1 ring-amber-400/20">
                                {Object.keys(scan.cardInfo).length} полей
                              </span>
                            ) : (
                              <span className="text-xs text-zinc-600">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedScan(scan)
                              }}
                              className="btn-ghost inline-flex border-0 py-1.5 pl-3 pr-2 text-xs text-violet-300 hover:text-violet-200"
                            >
                              Подробнее
                              <ChevronRight className="h-4 w-4 opacity-70" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          </div>

          {/* Адресная книга карт */}
          <div className="flex flex-col gap-4">
            <GlassCard>
              <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold text-white">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/12 ring-1 ring-amber-400/20">
                  <BookUser className="h-5 w-5 text-amber-300" />
                </span>
                Список карт
              </h2>
              <p className="mb-5 text-xs leading-relaxed text-zinc-500">
                UID и подпись — при скане в ленте подставится имя из списка. Всё хранится
                локально в браузере.
              </p>

              <div className="mb-5 space-y-3 rounded-xl border border-violet-500/15 bg-violet-500/[0.04] p-4 ring-1 ring-violet-400/10">
                <p className="text-xs font-semibold uppercase tracking-wide text-violet-300/90">
                  Новая карта
                </p>
                <input
                  type="text"
                  value={newUid}
                  onChange={(e) => setNewUid(e.target.value.replace(/\s/g, ''))}
                  placeholder="UID (hex, напр. A1B2C3D4)"
                  className="input-field font-mono text-xs"
                />
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Подпись или имя"
                  className="input-field"
                />
                <input
                  type="text"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Заметка (необязательно)"
                  className="input-field"
                />
                <button type="button" onClick={handleAddCard} className="btn-primary w-full">
                  <Plus className="h-4 w-4" />
                  Добавить в список
                </button>
              </div>

              <div className="mb-4 flex flex-wrap gap-2">
                <button type="button" onClick={seedExampleCards} className="btn-secondary text-xs">
                  Загрузить примеры
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm('Очистить весь список карт?')) replaceAll([])
                  }}
                  className="btn-danger-ghost text-xs"
                >
                  Очистить всё
                </button>
              </div>

              <div className="max-h-[280px] space-y-2 overflow-y-auto pr-0.5">
                {cards.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-white/[0.08] py-8 text-center text-sm text-zinc-500">
                    Список пуст — добавьте UID выше или из блока «Подробнее» после скана.
                  </p>
                ) : (
                  cards.map((c) => (
                    <div
                      key={c.id}
                      className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 transition hover:border-white/[0.1]"
                    >
                      {editingCardId === c.id ? (
                        <div className="space-y-2">
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="input-field py-2 text-sm"
                          />
                          <input
                            value={editNote}
                            onChange={(e) => setEditNote(e.target.value)}
                            placeholder="Заметка"
                            className="input-field py-2 text-sm"
                          />
                          <div className="flex flex-wrap gap-2 pt-1">
                            <button
                              type="button"
                              className="btn-primary py-2 text-xs"
                              onClick={() => {
                                updateCard(c.id, { name: editName, note: editNote })
                                setEditingCardId(null)
                              }}
                            >
                              Сохранить
                            </button>
                            <button
                              type="button"
                              className="btn-ghost py-2 text-xs text-zinc-400"
                              onClick={() => setEditingCardId(null)}
                            >
                              Отмена
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-3">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/25 to-amber-500/10 text-sm font-semibold text-violet-200 ring-1 ring-white/10">
                            {c.avatar}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium leading-tight text-zinc-100">{c.name}</p>
                            <p className="font-mono text-[11px] text-zinc-500">{c.id}</p>
                            {c.note ? (
                              <p className="mt-1 text-xs text-zinc-400">{c.note}</p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <button
                              type="button"
                              className="btn-ghost rounded-lg p-2 text-zinc-500 hover:text-violet-300"
                              title="Изменить"
                              onClick={() => {
                                setEditingCardId(c.id)
                                setEditName(c.name)
                                setEditNote(c.note || '')
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="btn-ghost rounded-lg p-2 text-zinc-500 hover:text-rose-400"
                              title="Удалить"
                              onClick={() => removeCard(c.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </GlassCard>

            {deviceOnline && (
              <GlassCard>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-200">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/12">
                    <Key className="h-4 w-4 text-amber-300" />
                  </span>
                  Запись на MIFARE
                </h3>
                <p className="mb-3 text-xs leading-relaxed text-zinc-500">
                  16 байт — сектор 1, блок 1. После нажатия приложите карту к антенне.
                </p>
                <div className="flex flex-wrap items-stretch gap-2">
                  <input
                    type="text"
                    value={cardLabel}
                    onChange={(e) => setCardLabel(e.target.value)}
                    placeholder="Метка (до 16 симв.)"
                    maxLength={16}
                    className="input-field min-w-[120px] flex-1 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={writeToCard}
                    disabled={writeStatus === 'waiting'}
                    className="btn-primary shrink-0 px-5 disabled:cursor-not-allowed"
                  >
                    {writeStatus === 'waiting' ? 'Ожидание карты…' : 'Записать'}
                  </button>
                </div>
                {writeStatus === 'ok' && (
                  <p className="mt-3 text-sm font-medium text-emerald-400/95">Готово — блок записан</p>
                )}
                {writeStatus === 'err' && (
                  <p className="mt-3 text-sm font-medium text-rose-400/95">Не удалось записать</p>
                )}
              </GlassCard>
            )}

            {deviceOnline && (
              <GlassCard>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-200">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/12">
                    <Palette className="h-4 w-4 text-violet-300" />
                  </span>
                  RGB-палитра подсветки
                </h3>
                <p className="mb-4 text-xs leading-relaxed text-zinc-500">
                  Выберите цвет вручную и отправьте его на Arduino. Кнопка «Авто-дыхание» возвращает
                  стандартную анимацию ожидания.
                </p>

                <div className="mb-4 rounded-xl border border-white/[0.08] bg-zinc-900/60 p-3">
                  <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-zinc-500">
                    <span>Превью</span>
                    <span className="font-mono text-zinc-400">{effectiveLedHex.toUpperCase()}</span>
                  </div>
                  <div
                    className="h-12 rounded-lg ring-1 ring-white/10"
                    style={{
                      background: `linear-gradient(120deg, ${effectiveLedHex}, ${ledHex})`,
                      boxShadow: `0 0 28px ${effectiveLedHex}44`,
                    }}
                  />
                </div>

                <div className="mb-4 flex flex-wrap gap-2">
                  {LED_SWATCHES.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      title={`Выбрать ${hex}`}
                      onClick={() => {
                        setLedHex(hex)
                        sendRgbColor(hex, ledBrightness)
                      }}
                      className="h-8 w-8 rounded-lg ring-1 ring-white/20 transition hover:scale-105"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </div>

                <div className="mb-4 flex items-center gap-3">
                  <input
                    type="color"
                    value={ledHex}
                    onChange={(e) => setLedHex(e.target.value)}
                    className="h-10 w-12 cursor-pointer rounded-lg border border-white/12 bg-transparent"
                    title="Кастомный цвет"
                  />
                  <input
                    type="text"
                    value={ledHex.toUpperCase()}
                    readOnly
                    className="input-field font-mono text-xs"
                    title="Текущий HEX-цвет"
                  />
                </div>

                <div className="mb-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
                    <span className="flex items-center gap-1">
                      <SunMedium className="h-3.5 w-3.5 text-amber-300/80" />
                      Яркость
                    </span>
                    <span className="font-mono text-zinc-300">{ledBrightness}%</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={1}
                    value={ledBrightness}
                    onChange={(e) => setLedBrightness(Number(e.target.value))}
                    className="w-full accent-violet-400"
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => sendRgbColor()} className="btn-primary text-xs">
                    Применить цвет
                  </button>
                  <button type="button" onClick={sendRgbAuto} className="btn-secondary text-xs">
                    Авто-дыхание
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLedHex('#000000')
                      sendRgbColor('#000000', 100)
                    }}
                    className="btn-ghost text-xs text-zinc-400"
                  >
                    Выключить LED
                  </button>
                </div>

                {ledStatus === 'sending' && (
                  <p className="mt-3 text-xs font-medium text-zinc-400">Отправка команды…</p>
                )}
                {ledStatus === 'ok' && (
                  <p className="mt-3 text-xs font-medium text-emerald-400/95">Цвет применён</p>
                )}
                {ledStatus === 'err' && (
                  <p className="mt-3 text-xs font-medium text-rose-400/95">Не удалось отправить команду RGB</p>
                )}
              </GlassCard>
            )}
          </div>
        </div>

        {selectedScan && (
          <GlassCard className="mt-8 border-violet-500/15 ring-violet-500/10">
            <CardInfoPanel
              scan={selectedScan}
              onClose={() => setSelectedScan(null)}
              registeredIds={new Set(cards.map((c) => c.id))}
              onAddToBook={(name, note) => handleAddFromScan(selectedScan, name, note)}
            />
          </GlassCard>
        )}
      </main>
    </div>
  )
}

const CARD_FIELD_LABELS = {
  PICC_TYPE_ID: 'ID типа PICC (библиотека MFRC522)',
  PICC_TYPE_NAME: 'Тип метки / чипа',
  UID_LEN_BYTES: 'Длина UID (байт)',
  UID_RAW: 'UID (сырой hex)',
  SAK: 'SAK (Select Acknowledge)',
  MEM_KB_HINT: 'Объём памяти (оценка, Кбит)',
  SECTOR0_AUTH: 'Аутентификация сектора 0',
  SECTOR0_AUTH_ERR: 'Код ошибки аутентификации',
  FAMILY: 'Семейство',
  NOTE: 'Примечание',
}

function formatCardFieldKey(key) {
  if (key.startsWith('BLK_S0_')) return `Сектор 0, блок ${key.replace('BLK_S0_', '')} (16 байт hex)`
  if (key.startsWith('UL_PAGE_')) return `Страница Ultralight ${key.replace('UL_PAGE_', '')} (4 байт hex)`
  return CARD_FIELD_LABELS[key] || key
}

function CardInfoPanel({ scan, onClose, registeredIds, onAddToBook }) {
  const [addName, setAddName] = useState('')
  const [addNote, setAddNote] = useState('')
  const info = scan.cardInfo
  const already = registeredIds?.has(scan.userId)
  const entries = info && typeof info === 'object' ? Object.entries(info).sort(([a], [b]) => a.localeCompare(b)) : []

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-white">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 ring-1 ring-violet-400/25">
              <Cpu className="h-5 w-5 text-violet-300" />
            </span>
            Скан и данные ридера
          </h2>
          <p className="mt-3 text-sm text-zinc-500">
            UID{' '}
            <span className="font-mono text-base font-semibold text-violet-300">{scan.userId}</span>
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
            <span>
              Подпись в ленте:{' '}
              <span className="font-medium text-zinc-100">{scan.userName}</span>
            </span>
            {scan.inAddressBook ? (
              <span className="inline-flex rounded-full bg-violet-500/20 px-2.5 py-0.5 text-xs font-semibold text-violet-200 ring-1 ring-violet-400/25">
                В списке
              </span>
            ) : (
              <span className="inline-flex rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-semibold text-zinc-400 ring-1 ring-white/[0.08]">
                Нет в списке
              </span>
            )}
          </p>
          {!scan.inAddressBook && (
            <p className="mt-2 max-w-xl text-xs leading-relaxed text-zinc-500">
              Добавьте карту в список справа — тогда подпись подставится автоматически при следующих
              сканах.
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="btn-secondary shrink-0">
          <X className="h-4 w-4 opacity-70" />
          Закрыть
        </button>
      </div>

      {!already && (
        <div className="mb-8 rounded-2xl border border-violet-500/20 bg-violet-500/[0.06] p-5 ring-1 ring-violet-400/15">
          <p className="mb-3 text-sm font-semibold text-violet-200">Добавить эту карту в список</p>
          <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
            <input
              type="text"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="Подпись (обязательно)"
              className="input-field min-w-[200px] flex-1"
            />
            <input
              type="text"
              value={addNote}
              onChange={(e) => setAddNote(e.target.value)}
              placeholder="Заметка"
              className="input-field min-w-[160px] flex-1"
            />
            <button
              type="button"
              disabled={!addName.trim()}
              onClick={() => {
                onAddToBook?.(addName.trim(), addNote.trim())
                setAddName('')
                setAddNote('')
              }}
              className="btn-primary shrink-0 disabled:cursor-not-allowed"
            >
              <Plus className="h-4 w-4" />
              Сохранить {scan.userId.slice(0, 8)}…
            </button>
          </div>
        </div>
      )}

      {!entries.length ? (
        <div className="flex gap-3 rounded-xl border border-white/[0.06] bg-zinc-950/50 px-4 py-5 text-sm text-zinc-400">
          <Cpu className="h-5 w-5 shrink-0 text-zinc-500" />
          <p>
            Расширенный блок META с ридера пока пуст. Обновите скетч Arduino — здесь появятся тип
            чипа, блоки памяти и служебные поля.
          </p>
        </div>
      ) : (
        <div className="grid max-h-[min(70vh,520px)] gap-3 overflow-y-auto sm:grid-cols-2">
          {entries.map(([key, value]) => {
            const isHex = /^[0-9A-Fa-f]+$/.test(String(value)) && String(value).length >= 8
            return (
              <div
                key={key}
                className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-3 text-sm ring-1 ring-white/[0.03]"
              >
                <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  {formatCardFieldKey(key)}
                </p>
                <p
                  className={`mt-1.5 break-all font-mono text-zinc-100 ${
                    isHex ? 'text-[11px] leading-relaxed' : 'text-sm'
                  }`}
                >
                  {String(value)}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function GlassCard({ children, className = '' }) {
  return <div className={`panel-surface ${className}`}>{children}</div>
}

function StatCard({ icon: Icon, label, value, sub, accent = 'violet', pulse }) {
  const styles = {
    violet: {
      icon: 'border-violet-500/35 bg-violet-500/10 text-violet-300 ring-1 ring-violet-400/20',
      glow: 'animate-pulse-glow border-violet-500/30',
    },
    amber: {
      icon: 'border-amber-500/30 bg-amber-500/10 text-amber-200 ring-1 ring-amber-400/15',
      glow: 'animate-pulse-glow-amber border-amber-500/25',
    },
  }
  const s = styles[accent] || styles.violet
  return (
    <div
      className={`rounded-2xl border bg-zinc-900/40 p-5 backdrop-blur-xl ${
        pulse ? s.glow : 'border-white/[0.07]'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`rounded-xl border p-2.5 ${s.icon}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
          <p className="mt-1 truncate text-lg font-semibold tracking-tight text-white">
            {typeof value === 'number' ? value.toLocaleString('ru') : value}
          </p>
          {sub ? (
            <p className="mt-1 truncate font-mono text-[11px] text-zinc-500" title={sub}>
              {sub}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
