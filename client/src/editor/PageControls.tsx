import { FileText, RectangleHorizontal, RectangleVertical, ScrollText } from 'lucide-react'
import { Modal } from '../components/ui'
import { ThemePicker } from '../components/ThemePicker'
import { MARGINS, PAGE_SIZES, type MarginId, type PageLayout, type PageSizeId } from './layout'
import { useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { DOC_SIZES, FONTS, type FontId } from './fonts'

interface Props {
  layout: PageLayout
  setLayout: (patch: Partial<PageLayout>) => void
}

const shortSize = (id: PageSizeId) => PAGE_SIZES[id].label.split(' (')[0]

/** Compact controls for the status bar: pages vs pageless, size, orientation, margins. */
export function PageControls({ layout, setLayout, pageCount, narrow, zoom }: Props & { pageCount: number; narrow: boolean; zoom: number }) {
  const paged = layout.mode === 'paged'
  return (
    <div className="page-controls">
      {pageCount > 0 && (
        <span className="muted hide-sm">
          {pageCount} page{pageCount === 1 ? '' : 's'}
        </span>
      )}
      {zoom < 1 && (
        <span className="muted small hide-sm" title="The page is scaled down to fit this window">
          {Math.round(zoom * 100)}%
        </span>
      )}
      {narrow && <span className="muted small hide-sm">Shown pageless: window too narrow for {shortSize(layout.size)}</span>}
      <div className="seg small" role="radiogroup" aria-label="Page view">
        <button role="radio" aria-checked={paged} className={paged ? 'on' : ''} onClick={() => setLayout({ mode: 'paged' })} title="Show separate pages, like a printed document">
          <FileText size={13} /> Pages
        </button>
        <button role="radio" aria-checked={!paged} className={!paged ? 'on' : ''} onClick={() => setLayout({ mode: 'pageless' })} title="One continuous page with no breaks">
          <ScrollText size={13} /> Pageless
        </button>
      </div>
      <select className="hide-sm" value={layout.size} onChange={(e) => setLayout({ size: e.target.value as PageSizeId })} aria-label="Page size" title={paged ? 'Page size' : 'Page size (used when printing)'}>
        {Object.keys(PAGE_SIZES).map((id) => (
          <option key={id} value={id}>
            {shortSize(id as PageSizeId)}
          </option>
        ))}
      </select>
      <button
        className="icon-btn hide-sm"
       
        onClick={() => setLayout({ orientation: layout.orientation === 'portrait' ? 'landscape' : 'portrait' })}
        title={`Orientation: ${layout.orientation} (click to switch)`}
        aria-label={`Orientation: ${layout.orientation}`}
      >
        {layout.orientation === 'portrait' ? <RectangleVertical size={16} /> : <RectangleHorizontal size={16} />}
      </button>
      <select className="hide-sm" value={layout.margins} onChange={(e) => setLayout({ margins: e.target.value as MarginId })} aria-label="Margins" title={paged ? 'Margins' : 'Margins (left and right edges in pageless view)'}>
        {Object.entries(MARGINS).map(([id, m]) => (
          <option key={id} value={id}>
            {m.label.split(' (')[0]} margins
          </option>
        ))}
      </select>
    </div>
  )
}

export function PageSetupDialog({ layout, setLayout, onClose }: Props & { onClose: () => void }) {
  return (
    <Modal
      title="Preferences"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="muted small">Just for you, on every device: collaborators see scripts their own way. Printing and downloads use your settings.</p>
      <fieldset className="layer-checks font-choices">
        <legend>Font</legend>
        <p className="muted small">One font and text size for every script. The font is also used for section titles, chips, visual notes and column headers.</p>
        <div className="font-row">
          <label>
            Font
            <select value={layout.font} onChange={(e) => setLayout({ font: e.target.value as FontId })} style={{ fontFamily: FONTS.find((f) => f.id === layout.font)?.stack }}>
              {FONTS.map((f) => (
                <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                  {f.label}
                  {f.id === 'inconsolata' ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="size-stepper-row">
            Size
            <SizeStepper value={layout.fontSize} onChange={(fontSize) => setLayout({ fontSize })} />
          </div>
        </div>
        <p className="font-preview" style={{ fontFamily: FONTS.find((f) => f.id === layout.font)?.stack, fontSize: `${layout.fontSize}pt` }}>
          Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
        </p>
      </fieldset>
      <fieldset className="layer-checks">
        <legend>View</legend>
        <label className="check">
          <input type="radio" name="mode" checked={layout.mode === 'paged'} onChange={() => setLayout({ mode: 'paged' })} /> Pages — separate sheets with page breaks
        </label>
        <label className="check">
          <input type="radio" name="mode" checked={layout.mode === 'pageless'} onChange={() => setLayout({ mode: 'pageless' })} /> Pageless — one continuous scroll
        </label>
      </fieldset>
      <fieldset className="layer-checks">
        <legend>Orientation</legend>
        <label className="check">
          <input type="radio" name="orient" checked={layout.orientation === 'portrait'} onChange={() => setLayout({ orientation: 'portrait' })} /> Portrait
        </label>
        <label className="check">
          <input type="radio" name="orient" checked={layout.orientation === 'landscape'} onChange={() => setLayout({ orientation: 'landscape' })} /> Landscape
        </label>
      </fieldset>
      <label className="block">
        Paper size
        <select value={layout.size} onChange={(e) => setLayout({ size: e.target.value as PageSizeId })}>
          {Object.entries(PAGE_SIZES).map(([id, s]) => (
            <option key={id} value={id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        Margins <span className="muted small">(in pageless view, the left and right edges of the text)</span>
        <select value={layout.margins} onChange={(e) => setLayout({ margins: e.target.value as MarginId })}>
          {Object.entries(MARGINS).map(([id, m]) => (
            <option key={id} value={id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="layer-checks">
        <legend>Theme</legend>
        <ThemePicker />
      </fieldset>
    </Modal>
  )
}

const MIN_PT = 6
const MAX_PT = 36
const clampPt = (n: number) => Math.min(MAX_PT, Math.max(MIN_PT, Math.round(n * 2) / 2))

/** Text size like Word / Google Docs: − and + step through the usual sizes; type any size. */
function SizeStepper({ value, onChange }: { value: number; onChange: (pt: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? DOC_SIZES.find((n) => n > value) ?? clampPt(value + 2) : [...DOC_SIZES].reverse().find((n) => n < value) ?? clampPt(value - 1)
    onChange(clampPt(next))
  }
  const commit = () => {
    if (draft === null) return
    const n = parseFloat(draft)
    if (Number.isFinite(n)) onChange(clampPt(n))
    setDraft(null)
  }
  return (
    <span className="size-stepper">
      <button type="button" className="tb-btn" aria-label="Smaller" title="Smaller" disabled={value <= MIN_PT} onClick={() => step(-1)}>
        <Minus size={14} />
      </button>
      <input
        className="tb-size-input"
        inputMode="decimal"
        aria-label="Text size in points"
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, '').slice(0, 4))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape' && draft !== null) {
            e.stopPropagation()
            setDraft(null)
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            step(e.key === 'ArrowUp' ? 1 : -1)
          }
        }}
      />
      <button type="button" className="tb-btn" aria-label="Bigger" title="Bigger" disabled={value >= MAX_PT} onClick={() => step(1)}>
        <Plus size={14} />
      </button>
      <span className="muted small">pt</span>
    </span>
  )
}
