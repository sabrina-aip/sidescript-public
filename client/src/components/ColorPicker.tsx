/**
 * Colour picker: a colour selector (saturation/brightness square, hue slider, hex), with the
 * Sidescript palette below it as one-click shortcuts, like Google Docs. Used for annotation
 * layers, chips and section bars.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { PALETTE } from '../editor/model'

type HSV = [number, number, number] // h 0-360, s 0-1, v 0-1

function hexToHsv(hex: string): HSV {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [(h * 60 + 360) % 360, max ? d / max : 0, max]
}
function hsvToHex([h, s, v]: HSV) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
  }
  return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s)

export function ColorPicker({ value, onChange, label, disabled }: { value: string; onChange: (hex: string) => void; label: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="cp-trigger"
        style={{ background: value }}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(!open)}
      />
      {open && <Popover anchor={btn.current!} value={value} onChange={onChange} label={label} onClose={() => setOpen(false)} />}
    </>
  )
}

function Popover({ anchor, value, onChange, label, onClose }: { anchor: HTMLElement; value: string; onChange: (hex: string) => void; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(value))
  const [hex, setHex] = useState(value)
  const [pos, setPos] = useState({ left: 0, top: 0 })

  // Follow changes made elsewhere (a collaborator, undo) unless the user is typing a hex.
  useEffect(() => {
    if (value.toLowerCase() !== hsvToHex(hsv)) setHsv(hexToHsv(value))
    setHex(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // Place under the swatch (or above it if there's no room), kept on screen.
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const el = ref.current!
      const w = el.offsetWidth
      const h = el.offsetHeight
      const left = Math.min(document.documentElement.clientWidth - w - 8, Math.max(8, r.left))
      const top = r.bottom + 6 + h <= window.innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - 6 - h)
      setPos({ left, top })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchor])

  // Close on a click elsewhere or Esc (without closing a dialog underneath).
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
      anchor.focus()
    }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [anchor, onClose])

  // Dragging sends at most one change per frame.
  const frame = useRef(0)
  const pending = useRef('')
  const emit = (next: string) => {
    pending.current = next
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      onChange(pending.current)
    })
  }
  const set = (next: HSV) => {
    setHsv(next)
    const h = hsvToHex(next)
    setHex(h)
    emit(h)
  }

  const sv = useRef<HTMLDivElement>(null)
  const dragSv = (e: React.PointerEvent) => {
    const el = sv.current!
    el.setPointerCapture(e.pointerId)
    const move = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      const s = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
      const v = Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height))
      set([hsv[0], s, v])
    }
    move(e)
    const onMove = (ev: PointerEvent) => move(ev)
    const up = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', up)
  }
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02
    const [h, s, v] = hsv
    const map: Record<string, HSV> = { ArrowLeft: [h, Math.max(0, s - step), v], ArrowRight: [h, Math.min(1, s + step), v], ArrowUp: [h, s, Math.min(1, v + step)], ArrowDown: [h, s, Math.max(0, v - step)] }
    if (map[e.key]) {
      e.preventDefault()
      set(map[e.key])
    }
  }

  const current = value.toLowerCase()
  const dot = (color: string, name: string) => (
    <button
      key={color}
      type="button"
      className="cp-dot"
      style={{ background: color }}
      title={`${name} ${color.toUpperCase()}`}
      aria-label={name}
      aria-pressed={current === color}
      onClick={() => {
        setHsv(hexToHsv(color))
        setHex(color)
        onChange(color)
      }}
    >
      {current === color && <Check size={13} strokeWidth={3} />}
    </button>
  )

  return createPortal(
    <div ref={ref} className="cp-pop" role="dialog" aria-label={label} style={{ left: pos.left, top: pos.top }}>
      <div
        ref={sv}
        className="cp-sv"
        style={{ '--hue': `hsl(${hsv[0]} 100% 50%)` } as React.CSSProperties}
        onPointerDown={dragSv}
        onKeyDown={nudge}
        tabIndex={0}
        role="slider"
        aria-label="Saturation and brightness"
        aria-valuetext={hex}
      >
        <span className="cp-knob" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: hex }} />
      </div>
      <input className="cp-hue" type="range" min={0} max={359} value={Math.round(hsv[0])} aria-label="Hue" onChange={(e) => set([Number(e.target.value), hsv[1], hsv[2]])} />
      <div className="cp-hex">
        <span className="cp-preview" style={{ background: hex }} />
        <input
          value={hex.toUpperCase()}
          aria-label="Hex colour"
          spellCheck={false}
          maxLength={7}
          onChange={(e) => {
            let v = e.target.value.trim()
            if (!v.startsWith('#')) v = '#' + v
            setHex(v)
            if (isHex(v)) {
              setHsv(hexToHsv(v))
              onChange(v.toLowerCase())
            }
          }}
          onKeyDown={(e) => e.key === 'Enter' && onClose()}
        />
      </div>
      <div className="cp-label">Sidescript palette</div>
      <div className="cp-dots">
        {PALETTE.map((p) => dot(p.light, p.lightName))}
        {PALETTE.map((p) => dot(p.deep, p.deepName))}
      </div>
    </div>,
    document.body,
  )
}
