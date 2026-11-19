import { useState, useSyncExternalStore } from 'react'
import { Hash, X } from 'lucide-react'
import type { ScriptContext } from './context'
import { chipText, type FieldDef, type VisualValue } from './fields'

/** Next label in a sequence: 1a → 1b, 1z → 1aa, 9 → 10, 2.1 → 2.2 */
export function nextLabel(s: string) {
  const num = /^(.*?)(\d+)$/.exec(s)
  if (num) return num[1] + String(Number(num[2]) + 1).padStart(num[2].length, '0')
  const letters = /^(.*?)([a-z]+|[A-Z]+)$/.exec(s)
  if (letters) {
    const upper = letters[2] === letters[2].toUpperCase()
    const chars = letters[2].toLowerCase().split('')
    let i = chars.length - 1
    while (i >= 0 && chars[i] === 'z') chars[i--] = 'a'
    if (i < 0) chars.unshift('a')
    else chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1)
    const out = chars.join('')
    return letters[1] + (upper ? out.toUpperCase() : out)
  }
  return s + '2'
}

export function sequence(start: string, n: number) {
  const out = [start]
  while (out.length < n) out.push(nextLabel(out[out.length - 1]))
  return out
}

/** Appears while beats are selected: change Visual / Scene / Status on all of them at once. */
export function BulkBar({ script, fields }: { script: ScriptContext; fields: FieldDef[] }) {
  useSyncExternalStore(script.selection.on, () => script.selection.version)
  const [text, setText] = useState<Record<string, string>>({}) // one box per text column
  const count = script.selection.list().length // ignores beats deleted since they were picked
  if (!count) return null
  const ids = () => script.selection.list()

  const chipSelect = (f: FieldDef) => (
    <select
      key={f.id}
      className="f-chip unset bulk-chip"
      value=""
      aria-label={`Set ${f.name} for selected beats`}
      onChange={(e) => {
        const v = e.target.value
        if (!v) return
        const value = v === '-' ? undefined : v
        if (f.type === 'visual')
          script.setMany(ids(), f.id, (_i, cur: VisualValue | undefined) => {
            const next = { ...(cur || {}), type: value }
            return next.type || next.desc || next.images?.length ? next : undefined
          })
        else script.setMany(ids(), f.id, () => value)
      }}
    >
      <option value="">{f.name} …</option>
      {(f.options || []).map((o) => (
        <option key={o.id} value={o.id} style={{ background: o.color, color: chipText(o.color) }}>
          {o.label}
        </option>
      ))}
      <option value="-">(clear)</option>
    </select>
  )

  const textField = (f: FieldDef) => (
    <form
      key={f.id}
      className="bulk-text"
      onSubmit={(e) => {
        e.preventDefault()
        script.setMany(ids(), f.id, () => (text[f.id] || '').trim())
      }}
    >
      <input value={text[f.id] || ''} onChange={(e) => setText({ ...text, [f.id]: e.target.value })} placeholder={f.name} aria-label={`${f.name} for selected beats`} maxLength={40} />
      <button className="btn small" type="submit" title={`Give every selected beat this ${f.name.toLowerCase()}`}>
        Set all
      </button>
      <button
        className="btn small"
        type="button"
        disabled={!(text[f.id] || '').trim()}
        title={`Number in order starting from “${(text[f.id] || '').trim() || '1a'}” (e.g. 2a, 2b, 2c… or 5, 6, 7…)`}
        onClick={() => {
          const labels = sequence((text[f.id] || '').trim(), count)
          script.setMany(ids(), f.id, (i) => labels[i])
        }}
      >
        <Hash size={13} /> Number
      </button>
    </form>
  )

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Edit selected beats">
      <strong>
        {count} beat{count === 1 ? '' : 's'} selected
      </strong>
      {fields.map((f) => (f.type === 'text' ? textField(f) : chipSelect(f)))}
      <button className="link-btn" onClick={() => script.selection.set(script.order())}>
        Select all
      </button>
      <button className="icon-btn" onClick={() => script.selection.clear()} aria-label="Clear selection" title="Clear selection (Esc)">
        <X size={16} />
      </button>
    </div>
  )
}
