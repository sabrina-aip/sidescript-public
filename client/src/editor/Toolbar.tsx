import { useEffect, useReducer, useRef } from 'react'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Code, Highlighter, ImagePlus, Italic, Link2, List, ListChecks, ListOrdered,
  Check, MessageSquarePlus, Minus, Quote, Redo2, RemoveFormatting, Strikethrough, Underline, Undo2,
} from 'lucide-react'
import { uploadFile } from '../api'
import { Menu } from '../components/ui'
import { toast } from '../util'
import type { Category } from './model'
import { DEFAULT_LINE_HEIGHT, LINE_HEIGHTS, type SpaceAfter } from './spacing'
import { K, keyLabel, tip } from './shortcuts'

/** Google Docs' "Line & paragraph spacing" icon: an up/down arrow beside three lines. */
function LineSpacingIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4v16" />
      <path d="M3 7l3-3 3 3" />
      <path d="M3 17l3 3 3-3" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  )
}

/** 'none' (older scripts) and unset both mean no space after. */
function spaceAfterOf(e: Editor): SpaceAfter {
  const v = (e.getAttributes('paragraph').spaceAfter ?? e.getAttributes('heading').spaceAfter) as SpaceAfter
  return v === 'small' || v === 'large' ? v : null
}

export function Toolbar({ editor, docId, categories, onAnnotate, onComment }: { editor: Editor; docId: string; categories: Category[]; onAnnotate: (id: string) => void; onComment: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      checklist: e.isActive('taskList'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      lineHeight: ((e.getAttributes('paragraph').lineHeight ?? e.getAttributes('heading').lineHeight) as number | null) ?? DEFAULT_LINE_HEIGHT,
      spaceAfter: spaceAfterOf(e),
      align: e.isActive({ textAlign: 'center' }) ? 'center' : e.isActive({ textAlign: 'right' }) ? 'right' : 'left',
    }),
  })
  const fileRef = useRef<HTMLInputElement>(null)
  // Undo/redo availability comes straight from the undo history (which also holds beat-data
  // edits that never touch the text), so the buttons stay right without nudging the editor.
  const um = yUndoPluginKey.getState(editor.state)?.undoManager
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!um) return
    const events = ['stack-item-added', 'stack-item-popped', 'stack-cleared'] as const
    events.forEach((ev) => um.on(ev, rerender))
    return () => events.forEach((ev) => um.off(ev, rerender))
  }, [um])
  const canUndo = (um?.undoStack.length ?? 0) > 0
  const canRedo = (um?.redoStack.length ?? 0) > 0
  const c = () => editor.chain().focus()

  const B = ({ on, label, onClick, children, disabled }: { on?: boolean; label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) => (
    <button className={`tb-btn ${on ? 'on' : ''}`} title={label} aria-label={label} aria-pressed={on} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  )

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
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <B label={tip('Undo', K.undo)} onClick={() => c().undo().run()} disabled={!canUndo}>
        <Undo2 size={16} />
      </B>
      <B label={tip('Redo', K.redo)} onClick={() => c().redo().run()} disabled={!canRedo}>
        <Redo2 size={16} />
      </B>
      <span className="tb-sep" />
      <B label={tip('Bold', K.bold)} on={s.bold} onClick={() => c().toggleBold().run()}>
        <Bold size={16} />
      </B>
      <B label={tip('Italic', K.italic)} on={s.italic} onClick={() => c().toggleItalic().run()}>
        <Italic size={16} />
      </B>
      <B label={tip('Underline', K.underline)} on={s.underline} onClick={() => c().toggleUnderline().run()}>
        <Underline size={16} />
      </B>
      <B label={tip('Strikethrough', K.strike)} on={s.strike} onClick={() => c().toggleStrike().run()}>
        <Strikethrough size={16} />
      </B>
      <B label={tip('Inline code', K.code)} on={s.code} onClick={() => c().toggleCode().run()}>
        <Code size={16} />
      </B>
      <B label="Link" on={s.link} onClick={setLink}>
        <Link2 size={16} />
      </B>
      <span className="tb-sep" />
      <B label={tip('Align left', K.alignLeft)} on={s.align === 'left'} onClick={() => c().setTextAlign('left').run()}>
        <AlignLeft size={16} />
      </B>
      <B label={tip('Align centre', K.alignCenter)} on={s.align === 'center'} onClick={() => c().setTextAlign('center').run()}>
        <AlignCenter size={16} />
      </B>
      <B label={tip('Align right', K.alignRight)} on={s.align === 'right'} onClick={() => c().setTextAlign('right').run()}>
        <AlignRight size={16} />
      </B>
      <span className="tb-sep" />
      <Menu
        label="Line & paragraph spacing"
        trigger={<LineSpacingIcon />}
        items={[
          { label: 'Line spacing', disabled: true },
          ...[...new Set([...LINE_HEIGHTS, s.lineHeight])]
            .sort((a, b) => a - b)
            .map((v) => ({
              label: v === 1 ? 'Single (1.0)' : v === 2 ? 'Double (2.0)' : String(v),
              icon: v === s.lineHeight ? <Check size={14} /> : undefined,
              onClick: () => c().setLineSpacing(v).run(),
            })),
          {
            label: 'Custom…',
            onClick: () => {
              const v = prompt('Line spacing (0.8 – 3), e.g. 1.25:', String(s.lineHeight))
              const n = v ? parseFloat(v) : NaN
              if (Number.isFinite(n)) c().setLineSpacing(n).run()
            },
          },
          { separator: true, label: '' },
          { label: 'Space after paragraph', disabled: true },
          ...(
            [
              [null, 'None'],
              ['small', 'Small'],
              ['large', 'Large'],
            ] as [SpaceAfter, string][]
          ).map(([v, label]) => ({ label, icon: v === s.spaceAfter ? <Check size={14} /> : undefined, onClick: () => c().setSpaceAfter(v).run() })),
        ]}
      />
      <span className="tb-sep" />
      <B label={tip('Checklist', K.checklist)} on={s.checklist} onClick={() => c().toggleTaskList().run()}>
        <ListChecks size={16} />
      </B>
      <B label={tip('Bulleted list', K.bullets)} on={s.bullet} onClick={() => c().toggleBulletList().run()}>
        <List size={16} />
      </B>
      <B label={tip('Numbered list', K.numbers)} on={s.ordered} onClick={() => c().toggleOrderedList().run()}>
        <ListOrdered size={16} />
      </B>
      <B label={tip('Quote', K.quote)} on={s.quote} onClick={() => c().toggleBlockquote().run()}>
        <Quote size={16} />
      </B>
      <B label="Divider" onClick={() => c().setHorizontalRule().run()}>
        <Minus size={16} />
      </B>
      <B label="Insert image" onClick={() => fileRef.current?.click()}>
        <ImagePlus size={16} />
      </B>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) insertImage(f)
        }}
      />
      {/* Clears text styling only — highlights and comments are kept. */}
      <B label="Clear formatting" onClick={() => ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'textStyle'].reduce((ch, m) => ch.unsetMark(m), c()).clearNodes().run()}>
        <RemoveFormatting size={16} />
      </B>
      <span className="tb-sep" />
      <Menu
        label="Annotate selection as…"
        trigger={
          <span className="tb-highlight">
            <Highlighter size={16} /> Annotate
          </span>
        }
        items={
          categories.length
            ? categories.map((cat, i) => ({
                label: cat.name,
                icon: <span className="swatch" style={{ background: cat.color }} />,
                hint: i < 9 ? keyLabel(K.annotate(i + 1)) : undefined,
                onClick: () => onAnnotate(cat.id),
              }))
            : [{ label: 'No annotations yet — add one in Label Options', disabled: true }]
        }
      />
      <B label={tip('Comment', K.comment)} onClick={onComment}>
        <MessageSquarePlus size={16} />
      </B>
    </div>
  )
}

