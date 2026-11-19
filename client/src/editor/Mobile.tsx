/**
 * The phone layout (screens up to MOBILE_WIDTH wide): a slim top bar, the script in one column,
 * four tabs at the bottom (Script, Outline, Notes, More), and a formatting bar that sits on the
 * keyboard while you type. Everything else (outline, notes, settings) opens as a sheet, so the
 * script keeps most of the screen. The desktop toolbar, layer bar, Table and Focus views, page
 * setup and bulk editing stay on larger screens.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import { useEditorState } from '@tiptap/react'
import { Bold, Check, FileText, ImagePlus, Italic, Link2, ListTree, MessageSquare, MessageSquarePlus, MoreHorizontal, Plus, Rows3, Underline, Undo2, X } from 'lucide-react'
import { uploadFile } from '../api'
import { toast } from '../util'
import type { Category } from './model'
import type { ViewState } from './LayerBar'

export const MOBILE_WIDTH = 700
const query = `(max-width: ${MOBILE_WIDTH}px)`

function subscribe(cb: () => void) {
  const mq = window.matchMedia(query)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
/** True on phone-sized screens; follows rotation and window resizes. */
export const useIsMobile = () => useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)

/** Buttons on the keyboard bar must not take focus, or the keyboard would close. */
const keep = { onPointerDown: (e: React.PointerEvent) => e.preventDefault(), onMouseDown: (e: React.MouseEvent) => e.preventDefault() }

/**
 * Shown only while the script has focus (the keyboard is up), pinned just above the keyboard.
 * Top row: annotate the selection with a layer, or comment. Bottom row: the few formatting
 * and structure actions worth having on a phone.
 */
export function MobileKeyboardBar({ editor, docId, categories, onAnnotate, onComment, onOpenChange }: {
  editor: Editor
  docId: string
  categories: Category[]
  onAnnotate: (id: string) => void
  onComment: () => void
  onOpenChange: (open: boolean) => void
}) {
  const [focused, setFocused] = useState(editor.isFocused)
  useEffect(() => {
    let t: number | undefined
    const on = () => (clearTimeout(t), setFocused(true))
    // A short delay so tapping from one beat field to the script doesn't flash the bar.
    const off = () => (clearTimeout(t), (t = window.setTimeout(() => setFocused(false), 120)))
    editor.on('focus', on)
    editor.on('blur', off)
    return () => {
      clearTimeout(t)
      editor.off('focus', on)
      editor.off('blur', off)
    }
  }, [editor])
  useEffect(() => onOpenChange(focused), [focused, onOpenChange])

  // Sit on top of the on-screen keyboard: the visual viewport shrinks while it's open.
  const [bottom, setBottom] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setBottom(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), link: e.isActive('link'), empty: e.state.selection.empty }),
  })
  const um = yUndoPluginKey.getState(editor.state)?.undoManager
  const fileRef = useRef<HTMLInputElement>(null)
  const c = () => editor.chain().focus()

  if (!focused) return null

  function setLink() {
    const prev = editor.getAttributes('link').href || ''
    const url = prompt('Link URL (leave empty to remove):', prev)
    if (url === null) return
    if (!url) return c().extendMarkRange('link').unsetLink().run()
    if (!/^(https?:|mailto:|\/|#)/i.test(url)) return toast('Links must start with http://, https:// or mailto:', 'error')
    c().extendMarkRange('link').setLink({ href: url }).run()
  }
  async function insertImage(file: File) {
    try {
      const { url } = await uploadFile(docId, file)
      c().setImage({ src: url, alt: file.name }).run()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <div className="m-kbar" style={{ bottom }} role="toolbar" aria-label="Formatting">
      <div className={`m-kbar-layers ${s?.empty ? 'idle' : ''}`}>
        <span className="m-kbar-label">{s?.empty ? 'Select text to annotate' : 'Annotate'}</span>
        {categories.map((cat) => (
          <button key={cat.id} className="m-chip" {...keep} onClick={() => onAnnotate(cat.id)} aria-label={`Annotate as ${cat.name}`}>
            <span className="m-dot" style={{ background: cat.color }} />
            {cat.name}
          </button>
        ))}
        <button className="m-chip" {...keep} onClick={onComment}>
          <MessageSquarePlus size={14} /> Comment
        </button>
      </div>
      <div className="m-kbar-fmt">
        <button {...keep} onClick={() => c().undo().run()} disabled={!um?.canUndo()} aria-label="Undo">
          <Undo2 size={19} />
        </button>
        <button {...keep} className={s?.bold ? 'on' : ''} onClick={() => c().toggleBold().run()} aria-label="Bold" aria-pressed={!!s?.bold}>
          <Bold size={19} />
        </button>
        <button {...keep} className={s?.italic ? 'on' : ''} onClick={() => c().toggleItalic().run()} aria-label="Italic" aria-pressed={!!s?.italic}>
          <Italic size={19} />
        </button>
        <button {...keep} className={s?.underline ? 'on' : ''} onClick={() => c().toggleUnderline().run()} aria-label="Underline" aria-pressed={!!s?.underline}>
          <Underline size={19} />
        </button>
        <button {...keep} className={s?.link ? 'on' : ''} onClick={setLink} aria-label="Link">
          <Link2 size={19} />
        </button>
        <button {...keep} onClick={() => fileRef.current?.click()} aria-label="Insert image">
          <ImagePlus size={19} />
        </button>
        <button {...keep} className="labelled" onClick={() => editor.commands.keyboardShortcut('Mod-Enter')}>
          <Plus size={17} />
          Beat
        </button>
        <button {...keep} className="labelled" onClick={() => editor.commands.keyboardShortcut('Mod-Shift-Enter')}>
          <Rows3 size={17} />
          Section
        </button>
        <button {...keep} className="labelled done" onClick={() => editor.commands.blur()}>
          <Check size={17} />
          Done
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void insertImage(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

export type MobileTab = 'script' | 'outline' | 'notes' | 'more'

export function MobileTabs({ tab, notesCount, onSelect }: { tab: MobileTab; notesCount: number; onSelect: (t: MobileTab) => void }) {
  const item = (id: MobileTab, label: string, icon: ReactNode, badge?: number) => (
    <button className={`m-tab ${tab === id ? 'active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => onSelect(id)}>
      {icon}
      {!!badge && <span className="m-badge">{badge > 99 ? '99+' : badge}</span>}
      {label}
    </button>
  )
  return (
    <nav className="m-tabs" aria-label="Script">
      {item('script', 'Script', <FileText size={21} />)}
      {item('outline', 'Outline', <ListTree size={21} />)}
      {item('notes', 'Notes', <MessageSquare size={21} />, notesCount)}
      {item('more', 'More', <MoreHorizontal size={21} />)}
    </nav>
  )
}

export interface SheetAction {
  label: string
  icon: ReactNode
  onClick: (trigger: HTMLElement) => void
  danger?: boolean
}

/** The More tab: which layers show, plus the document actions that used to live in the ⋯ menu. */
export function MobileMoreSheet({ categories, view, setView, actions, onClose }: {
  categories: Category[]
  view: ViewState
  setView: (fn: (v: ViewState) => ViewState) => void
  actions: SheetAction[]
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const shown = view.mode !== 'script'
  const toggleLayer = (id: string) =>
    setView((v) => ({ ...v, mode: v.mode === 'script' ? 'annotated' : v.mode, hidden: v.hidden.includes(id) ? v.hidden.filter((h) => h !== id) : [...v.hidden, id] }))
  return (
    <>
      <div className="m-backdrop" onClick={onClose} />
      <section className="m-sheet" role="dialog" aria-modal="true" aria-label="More">
        <div className="m-grab" />
        <header className="m-sheet-head">
          <h2>More</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        <div className="m-sheet-body">
          <h3 className="m-sheet-label">Show</h3>
          <label className="m-row">
            <span className="m-row-text">Annotations and comments</span>
            <input type="checkbox" className="m-switch" checked={shown} onChange={() => setView((v) => ({ ...v, mode: shown ? 'script' : 'annotated' }))} />
          </label>
          {categories.map((cat) => (
            <label key={cat.id} className={`m-row sub ${shown ? '' : 'off'}`}>
              <span className="m-dot" style={{ background: cat.color }} />
              <span className="m-row-text">{cat.name}</span>
              <input type="checkbox" className="m-switch" checked={shown && !view.hidden.includes(cat.id)} onChange={() => toggleLayer(cat.id)} />
            </label>
          ))}
          <label className={`m-row sub ${shown ? '' : 'off'}`}>
            <span className="m-dot comment" />
            <span className="m-row-text">Comments</span>
            <input type="checkbox" className="m-switch" checked={shown && view.comments} onChange={() => setView((v) => ({ ...v, mode: v.mode === 'script' ? 'annotated' : v.mode, comments: !(v.mode !== 'script' && v.comments) }))} />
          </label>
          <h3 className="m-sheet-label">Document</h3>
          {actions.map((a) => (
            <button key={a.label} className={`m-row action ${a.danger ? 'danger' : ''}`} onClick={(e) => a.onClick(e.currentTarget)}>
              {a.icon}
              <span className="m-row-text">{a.label}</span>
            </button>
          ))}
        </div>
      </section>
    </>
  )
}
