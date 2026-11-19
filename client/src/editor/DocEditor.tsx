import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { CharacterCount, Placeholder } from '@tiptap/extensions'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import type { Editor } from '@tiptap/core'
import * as Y from 'yjs'
import { ArrowLeft, Check, CloudOff, Copy, Download, Eye, Highlighter, History, Keyboard, Loader2, MessageSquarePlus, MoreHorizontal, Printer, Share2, SlidersHorizontal, Trash2 } from 'lucide-react'
import { api, uploadFile, type DocMeta, type User } from '../api'
import type { SaveStatus, SyncProvider } from '../collab/provider'
import { Avatar, Menu } from '../components/ui'
import { makeThumbnail, navigate, tint, toast, uid, useLocalState } from '../util'
import { baseExtensions } from './extensions'
import { fontStack } from './fonts'
import { pageGeometry, pagelessInset, type PageGeometry } from './layout'
import { setDisplay, useDisplayPrefs } from '../displayPrefs'
import { Pagination, refreshPagination } from './pagination'
import { PageControls, PageSetupDialog } from './PageControls'
import { addAnchor, collectAnchors, removeAnchor, type AnchorInfo } from './marks'
import { getMaps, highlightStyle, sortCategories, useYMap, type Note, type Thread } from './model'
import { createScriptContext, DATA_ORIGIN } from '../script/context'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import { ScriptBehaviour } from '../script/nodes'
import { chipText, DEFAULT_SECTION_COLOR, getFieldList, MAX_FIELDS, tableColumns, type FieldDef } from '../script/fields'
import { addColumn, deleteColumn, renameColumn } from '../script/columns'
import { confirmAt } from '../components/confirmAt'
import { withUndo } from './undoable'
import { ShortcutsDialog } from './ShortcutsDialog'
import { K, keyLabel, tip } from './shortcuts'
import { LabelsDialog } from '../script/LabelsDialog'
import { BulkBar } from '../script/BulkBar'
import { readOutline } from '../script/outline'
import { readClipboardTable } from '../script/tableImport'
import { pasteTable } from '../script/pasteTable'
import { Toolbar } from './Toolbar'
import { LayerBar, type ViewState } from './LayerBar'
import { SidePanel } from './SidePanel'
import { OutlineDrawer } from './OutlineDrawer'
import { ExportDialog, HistoryDialog, ShareDialog } from './dialogs'
import { MobileKeyboardBar, MobileMoreSheet, MobileTabs, useIsMobile, type MobileTab } from './Mobile'


type Dialog = null | 'labels' | 'share' | 'history' | 'export' | 'page' | 'shortcuts'

export function DocEditor({ docId, meta, setMeta, user, ydoc, provider }: { docId: string; meta: DocMeta; setMeta: (m: DocMeta) => void; user: User; ydoc: Y.Doc; provider: SyncProvider }) {
  const canEdit = meta.role !== 'viewer'
  const maps = useMemo(() => getMaps(ydoc), [ydoc])
  const categories = sortCategories(useYMap(maps.categories))
  const notes = useYMap(maps.notes)
  const comments = useYMap(maps.comments)
  const metaMap = useYMap(maps.meta)
  const title: string = metaMap.get('title') || ''
  // Your own display settings (font, size, pages, paper, margins), not the document's.
  const layout = useDisplayPrefs()
  const setLayout = setDisplay
  const [pageCount, setPageCount] = useState(0)
  const [scrollWidth, setScrollWidth] = useState(() => window.innerWidth)
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setScrollWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const fullGeometry = useMemo(() => pageGeometry(layout), [layout])
  // Pages wider than the window are scaled down to fit. If that would make text
  // unreadably small (phones), the document is shown pageless; the setting is kept.
  const zoom = Math.min(1, (scrollWidth - 32) / fullGeometry.width)
  const fits = zoom >= 0.55
  // Hide the menus (title bar + formatting toolbar), per browser like Google Docs; and full screen.
  const [menusHidden, setMenusHidden] = useLocalState<boolean>('sidescript:menus-hidden', false)
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement)
  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => toast('Full screen isn’t available here'))
  }
  const [storedView, setView] = useLocalState<ViewState>(`sidescript:view:${docId}`, { hidden: [], comments: true, mode: 'annotated', panel: 'notes', group: 'position', layout: 'document' })
  // Phones get a simpler layout: Document view only (no Table or Focus), with sheets for the rest.
  // The saved view is left alone, so a larger screen still opens the way you left it.
  const mobile = useIsMobile()
  const view = useMemo<ViewState>(
    () => (mobile ? { ...storedView, layout: 'document', mode: storedView.mode === 'focus' ? 'annotated' : storedView.mode } : storedView),
    [mobile, storedView],
  )
  const [moreOpen, setMoreOpen] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const tableLayout = view.layout === 'table' && view.mode !== 'script'
  // The table is one continuous surface; pages apply to the document view (and printing).
  const geometry: PageGeometry | null = layout.mode === 'paged' && fits && !tableLayout ? fullGeometry : null
  const geometryRef = useRef(geometry)
  geometryRef.current = geometry

  const [active, setActive] = useState<{ kind: 'note' | 'comment'; id: string } | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [exportPreset, setExportPreset] = useState<'pdf' | undefined>()
  const [status, setStatus] = useState<SaveStatus>(provider.status)
  const [anchors, setAnchors] = useState<{ ann: AnchorInfo[]; cmt: AnchorInfo[] }>({ ann: [], cmt: [] })
  const [peers, setPeers] = useState<{ clientId: number; name: string; color: string }[]>([])

  const hidden = useMemo(() => new Set(view.hidden), [view.hidden])
  const visibleCat = useCallback((id: string) => !hidden.has(id) && view.mode !== 'script', [hidden, view.mode])

  // Beat data (scene, visual, status…) and folder state, shared with the plain-DOM beat views.
  const script = useMemo(
    () =>
      createScriptContext(ydoc, {
        docId,
        canEdit,
        upload: async (file) => {
          const thumbBlob = await makeThumbnail(file)
          const { url } = await uploadFile(docId, file)
          const thumb = thumbBlob ? (await uploadFile(docId, thumbBlob)).url : undefined
          return { url, thumb }
        },
      }),
    [ydoc, docId, canEdit],
  )
  const scriptRef = useRef(script)
  scriptRef.current = script
  const fieldsMap = useYMap(maps.fields)
  const dialogueName: string = fieldsMap.get('dialogueName') || 'Dialogue'
  const fieldList = useMemo(() => getFieldList(maps.fields), [fieldsMap, maps.fields])
  const columnWidths: Record<string, number> = fieldsMap.get('widths') || {}
  const columns = useMemo(() => tableColumns(fieldList, columnWidths), [fieldList, JSON.stringify(columnWidths)])
  const pageRef = useRef<HTMLDivElement>(null)
  const customSectionColor: string | undefined = fieldsMap.get('sectionColor')
  const sectionColor = customSectionColor || DEFAULT_SECTION_COLOR

  const editor = useEditor({
    extensions: [
      ...baseExtensions(script),
      ScriptBehaviour.configure({ ctx: script }),
      Placeholder.configure({
        includeChildren: true,
        showOnlyCurrent: false,
        // CSS shows the dialogue hint only in a beat whose single paragraph is empty.
        placeholder: ({ node }) => (!canEdit ? '' : node.type.name === 'sectionTitle' ? 'Section title' : node.type.name === 'paragraph' ? `Write dialogue…  (${keyLabel(K.newBeat)}: new beat)` : ''),
      }),
      CharacterCount,
      Pagination.configure({ getGeometry: () => geometryRef.current, onPageCount: setPageCount }),
      Collaboration.configure({ document: ydoc, field: 'default', yUndoOptions: { trackedOrigins: [DATA_ORIGIN] } }),
      CollaborationCaret.configure({ provider, user: { name: user.displayName, color: user.color } }),
    ],
    editable: canEdit,
    editorProps: {
      attributes: { class: 'doc-body', spellcheck: 'true', 'aria-label': 'Document text' },
      handlePaste: (_view, event) => {
        // A pasted table (Docs, Sheets, Word, Excel…) becomes sections and beats.
        const rows = canEdit ? readClipboardTable(event.clipboardData) : null
        if (rows && editorRef.current) {
          pasteTable(editorRef.current, scriptRef.current, rows)
          return true
        }
        return insertFiles(event.clipboardData?.files)
      },
      handleDrop: (view, event) => {
        const files = (event as DragEvent).dataTransfer?.files
        if (!files?.length) return false
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        return insertFiles(files, pos)
      },
    },
  })
  const editorRef = useRef<Editor | null>(editor)
  editorRef.current = editor

  function insertFiles(files: FileList | undefined | null, pos?: number) {
    const imgs = [...(files || [])].filter((f) => f.type.startsWith('image/'))
    if (!imgs.length || !canEdit) return false
    ;(async () => {
      for (const f of imgs) {
        try {
          const { url } = await uploadFile(docId, f)
          const ed = editorRef.current
          if (!ed) return
          const chain = ed.chain().focus()
          if (pos !== undefined) chain.insertContentAt(pos, { type: 'image', attrs: { src: url, alt: f.name } }).run()
          else chain.setImage({ src: url, alt: f.name }).run()
        } catch (e: any) {
          toast(e.message, 'error')
        }
      }
    })()
    return true
  }

  // ---- save status, presence, imports
  useEffect(() => {
    const off = provider.onStatus(setStatus)
    return () => void off()
  }, [provider])
  useEffect(() => {
    const aw = provider.awareness
    // Awareness changes on every cursor move (ours included). Only re-render when the people
    // present actually change, or fast typing re-rendered the whole editor on each keystroke
    // (and could hit React's update-depth limit).
    let last = ''
    const update = () => {
      const list: { clientId: number; name: string; color: string }[] = []
      aw.getStates().forEach((s, id) => id !== ydoc.clientID && s.user && list.push({ clientId: id, name: s.user.name, color: s.user.color }))
      const key = list.map((p) => `${p.clientId}:${p.name}:${p.color}`).join('|')
      if (key === last) return
      last = key
      setPeers(list)
    }
    aw.on('change', update)
    update()
    return () => aw.off('change', update)
  }, [provider, ydoc])

  useEffect(() => {
    if (!editor) return
    provider.onSynced(() => {
      const key = `sidescript:import:${docId}`
      const html = sessionStorage.getItem(key)
      if (html !== null) {
        sessionStorage.removeItem(key)
        if (!editor.state.doc.textContent) editor.commands.setContent(html)
      }
    })
  }, [editor, provider, docId])

  // On narrow screens the panel overlays the page, so start with it closed.
  useEffect(() => {
    if (window.matchMedia('(max-width: 1100px)').matches) setView((v) => ({ ...v, panel: null }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Font and size change where pages break, so they're part of the key too.
  const geometryKey = (geometry ? `${geometry.width}x${geometry.height}/${geometry.cssMargin}` : 'pageless') + `/${layout.font}/${layout.fontSize}`
  useEffect(() => {
    if (editor && !editor.isDestroyed) refreshPagination(editor.view)
  }, [editor, geometryKey])

  useEffect(() => {
    document.title = `${title || 'Untitled document'} – Sidescript`
  }, [title])

  // ---- keep an ordered list of annotation / comment anchors
  useEffect(() => {
    if (!editor) return
    let t: number | undefined
    const recompute = () => setAnchors({ ann: collectAnchors(editor.state.doc, 'annotation'), cmt: collectAnchors(editor.state.doc, 'comment') })
    const onUpdate = () => {
      clearTimeout(t)
      t = window.setTimeout(recompute, 120)
    }
    recompute()
    editor.on('update', onUpdate)
    return () => {
      clearTimeout(t)
      editor.off('update', onUpdate)
    }
  }, [editor])

  // ---- actions
  const annotate = useCallback(
    (catId: string) => {
      if (!editor || !canEdit) return
      const { from, to, empty } = editor.state.selection
      if (empty) return toast('Select some text to annotate first')
      const id = uid()
      const now = new Date().toISOString()
      maps.notes.set(id, { id, category: catId, text: '', attachments: [], author: user.username, authorName: user.displayName, createdAt: now, updatedAt: now, done: false })
      addAnchor(editor, 'annotation', { id, cat: catId }, from, to)
      setView((v) => ({ ...v, hidden: v.hidden.filter((h) => h !== catId), mode: v.mode === 'script' ? 'annotated' : v.mode, panel: 'notes' }))
      setActive({ kind: 'note', id })
    },
    [editor, canEdit, maps, user, setView],
  )

  const addComment = useCallback(() => {
    if (!editor) return
    const { from, to, empty } = editor.state.selection
    if (empty) return toast('Select some text to comment on')
    const id = uid()
    maps.comments.set(id, { id, author: user.username, authorName: user.displayName, text: '', createdAt: new Date().toISOString(), resolved: false, draft: true, replies: [] })
    addAnchor(editor, 'comment', { id }, from, to)
    setView((v) => ({ ...v, comments: true, mode: v.mode === 'script' ? 'annotated' : v.mode, panel: 'comments' }))
    setActive({ kind: 'comment', id })
  }, [editor, maps, user, setView])

  // Removed straight away; the message's Undo (or Ctrl+Z) brings back the highlight and its note.
  const removeNote = useCallback(
    (id: string, message = 'Annotation removed') => {
      withUndo(editor, message, () => {
        if (editor) removeAnchor(editor, 'annotation', id)
        script.transact(() => maps.notes.delete(id))
      })
      setActive(null)
    },
    [editor, maps, script],
  )

  const removeThread = useCallback(
    (id: string) => {
      if (editor) removeAnchor(editor, 'comment', id)
      maps.comments.delete(id)
      setActive(null)
    },
    [editor, maps],
  )

  const reveal = useCallback(
    (a: AnchorInfo) => {
      editor?.chain().setTextSelection({ from: a.from, to: a.to }).scrollIntoView().run()
    },
    [editor],
  )

  async function duplicate() {
    const r = await api<{ doc: DocMeta }>('POST', `/api/docs/${docId}/duplicate`)
    toast('Copy created')
    navigate(`/d/${r.doc.id}`)
  }
  async function trash(anchor: HTMLElement) {
    if (!(await confirmAt(anchor, { title: 'Move to trash?', message: 'It stays on the server and can be restored from the Trash tab.', confirm: 'Move to trash', danger: true }))) return
    await api('PATCH', `/api/docs/${docId}`, { trashed: true })
    navigate('/')
  }

  // Destroy the editor before React takes the page apart. Otherwise TipTap's <EditorContent>
  // strips our node views on unmount, ProseMirror redraws the whole script without them, reads
  // that back as an edit, syncs it, redraws again... and the page froze when you left a script
  // in the app (New document, Make a copy, back to the documents list). Layout cleanups run
  // parent-first, so this happens before <EditorContent> unmounts.
  useLayoutEffect(
    () => () => {
      if (editor && !editor.isDestroyed) editor.destroy()
    },
    [editor],
  )

  // ---- one undo history for text AND beat data (scene, visual, status, field key)
  useEffect(() => {
    if (!editor) return
    const um = yUndoPluginKey.getState(editor.state)?.undoManager
    if (!um) return
    um.addToScope([script.beats, script.fields, maps.categories, maps.notes])
    // Ctrl+Z while a chip or button has focus (e.g. right after a bulk edit) still undoes.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      const t = e.target as HTMLElement
      const inBeatData = !!t.closest('.beat-meta')
      if (!inBeatData) {
        if (t.closest('.ProseMirror')) return // the editor handles its own text
        if (t.matches('input:not([type=checkbox]):not([type=color]), textarea') || t.isContentEditable) return // other boxes (dialogs, notes): native undo
      }
      e.preventDefault()
      // A beat's own fields (scene, visual notes) share the main history; leave the box so it shows the restored value.
      if (inBeatData) t.blur()
      if (k === 'y' || e.shiftKey) editor.commands.redo()
      else editor.commands.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [editor, script, maps])

  // Beats created after the script has loaded are drawn immediately (see BeatView).
  useEffect(() => {
    if (!editor) return
    // The script's own beats are drawn as soon as it syncs; from the next frames on, any new beat
    // (Ctrl+Enter, paste) is drawn immediately. This used to wait a full second, and typing
    // straight after Ctrl+Enter in that first second could land in the wrong place.
    let raf = 0
    provider.onSynced(() => {
      raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => (script.ready = true))))
    })
    return () => cancelAnimationFrame(raf)
  }, [editor, provider, script])

  // ---- beat selection for bulk edits
  useEffect(() => {
    if (editor) script.setOrder(() => readOutline(editor.state.doc).flatMap((s) => s.beats.map((b) => b.id)))
  }, [editor, script])
  const selectionVersion = useSyncExternalStore(script.selection.on, () => script.selection.version)
  const hasSelection = selectionVersion >= 0 && script.selection.size > 0

  // ---- keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (e.key === 'Escape' && script.selection.size && !document.querySelector('.modal')) {
        script.selection.clear()
      } else if (e.key === 'Escape' && !document.querySelector('.modal, .menu, .confirm-pop, .cp-pop, .react-pop')) {
        // Esc deselects the selected annotation or comment (dialogs and menus close first).
        setActive(null)
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        toast(provider.hasUnsaved ? 'Saving…' : 'All changes are saved to your server automatically')
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setExportPreset('pdf')
        setDialog('export')
      } else if (mod && e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault()
        setMenusHidden((h) => !h)
      } else if (mod && !e.altKey && (e.key === '/' || e.code === 'Slash')) {
        e.preventDefault()
        setDialog((d) => (d === 'shortcuts' ? null : d ?? 'shortcuts'))
      } else if (mod && e.altKey && e.code === 'KeyM') {
        e.preventDefault()
        addComment()
      } else if (e.altKey && !mod && /^Digit[1-9]$/.test(e.code) && editor?.isFocused) {
        const c = categories[Number(e.code.slice(5)) - 1]
        if (c) {
          e.preventDefault()
          annotate(c.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [categories, annotate, addComment, editor, provider, script])

  // ---- clicking a highlight opens its note / comment
  function onDocClick(e: React.MouseEvent) {
    let el = e.target as HTMLElement | null
    while (el && !el.classList.contains('doc-body')) {
      if (el.matches('mark.ann')) {
        const id = el.getAttribute('data-ann')!
        const note = notes.get(id)
        if (note && !note.completed && visibleCat(note.category)) {
          setActive({ kind: 'note', id })
          setView((v) => ({ ...v, panel: 'notes' }))
          if (mobile) editor?.commands.blur() // read it in the sheet, without the keyboard on top
          return
        }
      } else if (el.matches('span.cmt') && view.comments && view.mode !== 'script') {
        const id = el.getAttribute('data-comment')!
        const t = comments.get(id)
        if (t && !t.resolved) {
          setActive({ kind: 'comment', id })
          setView((v) => ({ ...v, panel: 'comments' }))
          if (mobile) editor?.commands.blur()
          return
        }
      }
      el = el.parentElement
    }
    // Clicking anywhere else in the script deselects (a completed annotation's text included).
    setActive(null)
  }

  // Closing the side panel deselects too.
  useEffect(() => {
    if (!view.panel || view.mode === 'script') setActive(null)
  }, [view.panel, view.mode])

  // ---- layer visibility is pure CSS, so toggling is instant even in long documents
  const layerCss = useMemo(() => {
    const rules: string[] = []
    if (view.mode !== 'script') {
      for (const c of categories) {
        if (hidden.has(c.id)) continue
        const sel = `.doc-body mark.ann[data-cat="${CSS.escape(c.id)}"]`
        const hl = highlightStyle(c.color)
        const dk = highlightStyle(c.color, true)
        rules.push(`${sel}{background-color:${tint(c.color, hl.alpha)};${hl.underline ? `border-bottom:2px solid ${c.color};` : ''}cursor:pointer}`)
        // Dark theme (chosen, or the system's when following it): a lighter tint so text stays readable.
        const darkRule = `{background-color:${tint(c.color, dk.alpha)};border-bottom:2px solid ${c.color}}`
        rules.push(`@media (prefers-color-scheme: dark){:where(:root:not([data-theme])) ${sel}${darkRule}}`, `:where(:root[data-theme='dark']) ${sel}${darkRule}`)
        if (view.mode === 'focus') rules.push(`.focus-mode ${sel}{color:var(--text);opacity:1}`)
      }
      // Completed annotations disappear from the text (like resolved comments). Opening one from
      // the Completed section still shows where it is, while its card is selected (rule below).
      for (const n of notes.values())
        if (n.completed) rules.push(`.doc-body mark.ann[data-ann="${CSS.escape(n.id)}"]{background:none;border:0;cursor:text}`)
      if (view.comments) {
        rules.push('.doc-body span.cmt{background-color:var(--comment-bg);border-bottom:2px solid var(--comment-line);cursor:pointer}')
        for (const t of comments.values()) if (t.resolved || (t.draft && t.author !== user.username)) rules.push(`.doc-body span.cmt[data-comment="${CSS.escape(t.id)}"]{background:none;border:0;cursor:auto}`)
        if (view.mode === 'focus') rules.push('.focus-mode span.cmt{color:var(--text)}')
      }
      if (active?.kind === 'note') {
        const c = categories.find((c) => c.id === notes.get(active.id)?.category)
        // The focused highlight is emphasised only while its layer is switched on.
        if (c && !hidden.has(c.id)) rules.push(`.doc-body mark.ann[data-ann="${CSS.escape(active.id)}"]{background-color:${tint(c.color, Math.min(1, highlightStyle(c.color).alpha + 0.25))};box-shadow:0 0 0 1px ${c.color}}`)
      } else if (active?.kind === 'comment' && view.comments) rules.push(`.doc-body span.cmt[data-comment="${CSS.escape(active.id)}"]{background-color:var(--comment-active)}`)
    }
    return rules.join('\n')
  }, [categories, hidden, view.mode, view.comments, comments, active, notes, user.username])

  const panelOpen = view.panel && view.mode !== 'script'

  // ---- phone tabs: Script, Outline, Notes (the side panel as a sheet), More
  const mobileTab: MobileTab = moreOpen ? 'more' : view.outline ? 'outline' : panelOpen ? 'notes' : 'script'
  const notesCount = useMemo(() => {
    if (view.mode === 'script') return 0
    const ids = new Set<string>()
    for (const a of anchors.ann) {
      const n = notes.get(a.id)
      if (n && !n.completed && visibleCat(n.category)) ids.add(a.id)
    }
    if (view.comments) for (const a of anchors.cmt) if (comments.get(a.id) && !comments.get(a.id)!.resolved && !comments.get(a.id)!.draft) ids.add(a.id)
    return ids.size
  }, [anchors, notes, comments, visibleCat, view.mode, view.comments])
  const selectTab = (t: MobileTab) => {
    setMoreOpen(t === 'more')
    if (t === 'notes') setView((v) => ({ ...v, outline: false, mode: v.mode === 'script' ? 'annotated' : v.mode, panel: v.panel || 'notes' }))
    else setView((v) => ({ ...v, outline: t === 'outline', panel: null }))
  }
  const exportCtx = editor
    ? {
        editor,
        ydoc,
        title: title || 'Untitled document',
        categories,
        notes,
        comments,
        page: fullGeometry,
        landscape: layout.orientation === 'landscape',
        font: fontStack(layout.font),
        fontSize: layout.fontSize,
        fields: fieldList,
        dialogueName,
        sectionColor,
        beatData: (id: string) => (script.beats.get(id)?.toJSON() as Record<string, any>) || {},
      }
    : null

  return (
    <div className={`editor-app ${mobile ? 'mobile' : menusHidden ? 'menus-hidden' : ''}`} data-doc-font={layout.font} style={{ ['--doc-font' as string]: fontStack(layout.font), ['--doc-size' as string]: `${layout.fontSize}pt` }}>
      <style>{layerCss}</style>
      <header className="ed-top">
        <button className="icon-btn" onClick={() => navigate('/')} title="All documents" aria-label="All documents">
          <ArrowLeft size={18} />
        </button>
        <div className="ed-titlebox">
          <input className="ed-title" value={title} placeholder="Untitled document" readOnly={!canEdit} onChange={(e) => maps.meta.set('title', e.target.value.slice(0, 200))} aria-label="Document title" />
          <div className="ed-sub">
            <SaveBadge status={status} />
            {!canEdit && (
              <span className="pill">
                <Eye size={12} /> View only
              </span>
            )}
          </div>
        </div>
        <div className="ed-top-right">
          <div className="presence">
            {peers.slice(0, 5).map((p) => (
              <Avatar key={p.clientId} name={p.name} color={p.color} size={28} title={`${p.name} is here`} />
            ))}
            {peers.length > 5 && <span className="pill">+{peers.length - 5}</span>}
          </div>
          {mobile && (
            <button
              className={`icon-btn m-top-btn ${view.mode !== 'script' ? 'on' : ''}`}
              onClick={() => setView((v) => ({ ...v, mode: v.mode === 'script' ? 'annotated' : 'script' }))}
              aria-label={view.mode !== 'script' ? 'Hide annotations' : 'Show annotations'}
              aria-pressed={view.mode !== 'script'}
              title={view.mode !== 'script' ? 'Hide annotations' : 'Show annotations'}
            >
              <Highlighter size={20} />
            </button>
          )}
          {meta.role === 'owner' &&
            (mobile ? (
              <button className="icon-btn m-top-btn" onClick={() => setDialog('share')} aria-label="Share" title="Share">
                <Share2 size={20} />
              </button>
            ) : (
              <button className="btn primary" onClick={() => setDialog('share')}>
                <Share2 size={16} /> Share
              </button>
            ))}
          {!mobile && (<>
          <Menu
            label="File"
            align="right"
            trigger={<MoreHorizontal size={18} />}
            items={[
              { label: 'Make a copy', icon: <Copy size={16} />, onClick: duplicate },
              { separator: true, label: '' },
              { label: 'Download…', icon: <Download size={16} />, onClick: () => (setExportPreset(undefined), setDialog('export')) },
              { label: 'Print…', icon: <Printer size={16} />, hint: keyLabel(K.print), onClick: () => (setExportPreset('pdf'), setDialog('export')) },
              { label: 'Preferences…', icon: <SlidersHorizontal size={16} />, onClick: () => setDialog('page') },
              { label: 'Keyboard shortcuts', icon: <Keyboard size={16} />, hint: keyLabel(K.shortcuts), onClick: () => setDialog('shortcuts') },
              { label: 'Version history', icon: <History size={16} />, onClick: () => setDialog('history') },
              ...(meta.role === 'owner' ? [{ separator: true, label: '' }, { label: 'Move to trash', icon: <Trash2 size={16} />, danger: true, onClick: trash }] : []),
            ]}
          />
          <Avatar name={user.displayName} color={user.color} size={30} />
          </>)}
        </div>
      </header>

      {!mobile && editor && canEdit && <Toolbar editor={editor} docId={docId} categories={categories} onAnnotate={annotate} onComment={addComment} />}
      {!mobile && <LayerBar categories={categories} notes={notes} anchors={anchors.ann} comments={anchors.cmt.filter((a) => comments.get(a.id) && !comments.get(a.id)!.resolved && !comments.get(a.id)!.draft).length} view={view} setView={setView} onEditLabels={() => setDialog('labels')} canEdit={canEdit} menusHidden={menusHidden} onToggleMenus={() => setMenusHidden(!menusHidden)} fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />}

      <div className="ed-main">
        {view.outline && editor && <OutlineDrawer editor={editor} script={script} fields={fieldList} canEdit={canEdit} onClose={() => setView((v) => ({ ...v, outline: false }))} onJump={mobile ? () => setView((v) => ({ ...v, outline: false })) : undefined} />}
        <div className={`ed-scroll ${geometry ? 'paged' : 'pageless'}`} ref={scrollRef} onClick={(e) => e.target === e.currentTarget && setActive(null)}>
          <div
            ref={pageRef}
            className={`page ${geometry ? 'paged' : 'pageless'} ${tableLayout ? 'layout-table' : 'layout-document'} ${view.mode === 'script' ? 'script-mode' : ''} ${hasSelection ? 'has-selection' : ''} ${view.mode === 'focus' ? 'focus-mode' : ''}`}
            style={{
              ['--beat-cols' as string]: columns.template,
              ...(customSectionColor ? { ['--section-bg' as string]: customSectionColor, ['--section-fg' as string]: chipText(customSectionColor) } : {}),
              ...(geometry
                ? { zoom: zoom < 1 ? zoom : undefined, width: geometry.width, padding: `${geometry.margin.top}px ${geometry.margin.right}px ${geometry.margin.bottom}px ${geometry.margin.left}px` }
                : { ['--pageless-l' as string]: `${pagelessInset(layout).left}px`, ['--pageless-r' as string]: `${pagelessInset(layout).right}px` }),
            }}
            onClick={onDocClick}
            onMouseDown={(e) => {
              // Clicking the blank part of a page puts the cursor at the end, like a word processor.
              if (e.target === e.currentTarget && editor) {
                e.preventDefault()
                editor.commands.focus('end')
              }
            }}
          >
            {tableLayout && (
              <TableHead
                columns={columns}
                fieldList={fieldList}
                dialogueName={dialogueName}
                widths={columnWidths}
                canEdit={canEdit}
                script={script}
                pageRef={pageRef}
                onCommit={(widths) => script.transact(() => (Object.keys(widths).length ? script.fields.set('widths', widths) : script.fields.delete('widths')))}
              />
            )}
            <EditorContent editor={editor} />
          </div>
          {!mobile && editor && canEdit && <SelectionBubble editor={editor} categories={categories} onAnnotate={annotate} onComment={addComment} onSelectBeats={(ids) => script.selection.set(ids)} />}
        </div>
        {mobile && panelOpen && <div className="m-backdrop" onClick={() => setView((v) => ({ ...v, panel: null }))} />}
        {panelOpen && editor && (
          <SidePanel
            editor={editor}
            docId={docId}
            user={user}
            canEdit={canEdit}
            maps={maps}
            categories={categories}
            notes={notes}
            comments={comments}
            anchors={anchors}
            view={view}
            setView={setView}
            visibleCat={visibleCat}
            active={active}
            setActive={setActive}
            reveal={reveal}
            removeNote={removeNote}
            removeThread={removeThread}
            isOwner={meta.role === 'owner'}
          />
        )}
      </div>

      {!mobile && canEdit && <BulkBar script={script} fields={fieldList} />}
      {!mobile && (
        <footer className="ed-status">
          <span>
            <WordCount editor={editor} />
          </span>
          <PageControls layout={layout} setLayout={setLayout} pageCount={geometry ? pageCount : 0} narrow={layout.mode === 'paged' && !fits} zoom={geometry ? zoom : 1} />
        </footer>
      )}
      {mobile && editor && canEdit && <MobileKeyboardBar editor={editor} docId={docId} categories={categories} onAnnotate={annotate} onComment={addComment} onOpenChange={setKeyboardOpen} />}
      {mobile && !keyboardOpen && <MobileTabs tab={mobileTab} notesCount={notesCount} onSelect={selectTab} />}
      {mobile && moreOpen && (
        <MobileMoreSheet
          categories={categories}
          view={view}
          setView={setView}
          onClose={() => setMoreOpen(false)}
          actions={[
            ...(meta.role === 'owner' ? [{ label: 'Share', icon: <Share2 size={18} />, onClick: () => (setMoreOpen(false), setDialog('share')) }] : []),
            { label: 'Version history', icon: <History size={18} />, onClick: () => (setMoreOpen(false), setDialog('history')) },
            { label: 'Preferences', icon: <SlidersHorizontal size={18} />, onClick: () => (setMoreOpen(false), setDialog('page')) },
            { label: 'Make a copy', icon: <Copy size={18} />, onClick: () => (setMoreOpen(false), void duplicate()) },
            { label: 'Download', icon: <Download size={18} />, onClick: () => (setMoreOpen(false), setExportPreset(undefined), setDialog('export')) },
            ...(meta.role === 'owner' ? [{ label: 'Move to trash', icon: <Trash2 size={18} />, danger: true, onClick: (el: HTMLElement) => void trash(el) }] : []),
          ]}
        />
      )}

      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === 'page' && <PageSetupDialog layout={layout} setLayout={setLayout} onClose={() => setDialog(null)} />}
      {dialog === 'labels' && <LabelsDialog script={script} maps={maps} editor={editor} categories={categories} fields={fieldList} sectionColor={sectionColor} canEdit={canEdit} onClose={() => setDialog(null)} />}
      {dialog === 'share' && <ShareDialog meta={meta} setMeta={setMeta} onClose={() => setDialog(null)} />}
      {dialog === 'history' && editor && <HistoryDialog docId={docId} editor={editor} maps={maps} canEdit={canEdit} onClose={() => setDialog(null)} />}
      {dialog === 'export' && exportCtx && <ExportDialog ctx={exportCtx} view={view} preset={exportPreset} onClose={() => setDialog(null)} />}
    </div>
  )
}

function SaveBadge({ status }: { status: SaveStatus }) {
  const map = {
    connecting: [<Loader2 key="i" size={12} className="spin" />, 'Connecting…'],
    saving: [<Loader2 key="i" size={12} className="spin" />, 'Saving…'],
    saved: [<Check key="i" size={12} />, 'Saved to server'],
    offline: [<CloudOff key="i" size={12} />, 'Offline — changes kept in this browser'],
    outdated: [<CloudOff key="i" size={12} />, 'Sidescript was updated — reload the page to keep editing'],
    denied: [<CloudOff key="i" size={12} />, 'Access was removed'],
  } as const
  const [icon, text] = map[status]
  return (
    <span className={`save-badge ${status}`} role="status">
      {icon} {text}
    </span>
  )
}

/** Floating palette over a text selection: one click to highlight in any layer, or comment. */
/**
 * Table header with draggable column edges. Columns left of Dialogue resize from their right
 * edge, columns right of it from their left edge; Dialogue takes what's left. While dragging,
 * the grid is updated directly for smoothness; the width is saved (shared, undoable) on release.
 * Double-click an edge to reset that column.
 */
function TableHead({ columns, fieldList, dialogueName, widths, canEdit, script, pageRef, onCommit }: {
  columns: ReturnType<typeof tableColumns>
  script: ReturnType<typeof createScriptContext>
  fieldList: ReturnType<typeof getFieldList>
  dialogueName: string
  widths: Record<string, number>
  canEdit: boolean
  pageRef: React.RefObject<HTMLDivElement | null>
  onCommit: (widths: Record<string, number>) => void
}) {
  const headRef = useRef<HTMLDivElement>(null)
  const startDrag = (e: React.PointerEvent, fieldId: string, side: 'left' | 'right') => {
    e.preventDefault()
    const cell = (e.currentTarget as HTMLElement).parentElement!
    const dialogue = headRef.current?.querySelector<HTMLElement>('[data-col=dialogue]')
    const startW = cell.getBoundingClientRect().width
    const room = (dialogue?.getBoundingClientRect().width ?? 400) - 220 // keep Dialogue at least ~220px wide
    const x0 = e.clientX
    let next = startW
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      next = Math.max(70, Math.min(startW + room, side === 'right' ? startW + dx : startW - dx))
      pageRef.current?.style.setProperty('--beat-cols', tableColumns(fieldList, { ...widths, [fieldId]: next }).template)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('col-resizing')
      if (Math.abs(next - startW) >= 1) onCommit({ ...widths, [fieldId]: Math.round(next) })
    }
    document.body.classList.add('col-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const reset = (fieldId: string) => {
    const { [fieldId]: _drop, ...rest } = widths
    void _drop
    onCommit(rest)
  }
  const handle = (fieldId: string, side: 'left' | 'right', name: string) =>
    canEdit && (
      <span
        className={`col-resize ${side}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${name} column`}
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => startDrag(e, fieldId, side)}
        onDoubleClick={() => reset(fieldId)}
      />
    )
  // Click a column's name to rename it; its ⋯ menu deletes it or adds a column.
  const hasVisual = fieldList.some((f) => f.type === 'visual')
  const full = fieldList.length >= MAX_FIELDS
  const focusNew = (id?: string) => id && requestAnimationFrame(() => headRef.current?.querySelector<HTMLInputElement>(`[data-col="${id}"] .th-name`)?.select())
  const addItems = full
    ? [{ label: `Up to ${MAX_FIELDS + 1} columns`, disabled: true }]
    : [
        { label: 'Add text column', onClick: () => focusNew(addColumn(script, fieldList, 'text')) },
        { label: 'Add chips column', onClick: () => focusNew(addColumn(script, fieldList, 'select')) },
        ...(hasVisual ? [] : [{ label: 'Add Visual column (chip, note, image)', onClick: () => focusNew(addColumn(script, fieldList, 'visual')) }]),
      ]
  const cell = (id: string, name: string, field?: FieldDef) => (
    <>
      {canEdit ? (
        <input
          className="th-name"
          value={name}
          onChange={(e) => renameColumn(script, fieldList, id, e.target.value)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.currentTarget as HTMLInputElement).blur()}
          aria-label={`${name} column name`}
          title="Click to rename"
          spellCheck={false}
        />
      ) : (
        name
      )}
      {canEdit && (
        <span className="th-menu">
          <Menu
            label={`${name} column options`}
            align="right"
            trigger={<MoreHorizontal size={14} />}
            items={[
              ...addItems,
              ...(field
                ? [{ separator: true, label: '' }, { label: `Delete ${name} column…`, danger: true, icon: <Trash2 size={14} />, onClick: (trigger: HTMLElement) => void deleteColumn(script, fieldList, field, trigger) }]
                : [{ separator: true, label: '' }, { label: 'This column holds the beat text and can’t be deleted', disabled: true }]),
            ]}
          />
        </span>
      )}
    </>
  )
  return (
    <div className="table-head" ref={headRef}>
      {columns.before.map((f) => (
        <span key={f.id} data-col={f.id}>
          {cell(f.id, f.name, f)}
          {handle(f.id, 'right', f.name)}
        </span>
      ))}
      <span data-col="dialogue">{cell('dialogue', dialogueName)}</span>
      {columns.after.map((f) => (
        <span key={f.id} data-col={f.id}>
          {handle(f.id, 'left', f.name)}
          {cell(f.id, f.name, f)}
        </span>
      ))}
    </div>
  )
}

/**
 * Word and character count. Its own component: it changes on every keystroke, and re-rendering
 * the whole editor screen that often made fast typing or big pastes overrun React's update limit.
 */
function WordCount({ editor }: { editor: Editor | null }) {
  const counts = useEditorState({
    editor,
    selector: ({ editor }) => (editor ? { words: editor.storage.characterCount.words(), chars: editor.storage.characterCount.characters() } : { words: 0, chars: 0 }),
  })
  return (
    <>
      {counts?.words ?? 0} words <span className="hide-sm">· {counts?.chars ?? 0} characters</span>
    </>
  )
}

const NO_SELECTION = { from: 0, to: 0, empty: true, focused: false, beats: '' }

function SelectionBubble({ editor, categories, onAnnotate, onComment, onSelectBeats }: { editor: Editor; categories: ReturnType<typeof sortCategories>; onAnnotate: (id: string) => void; onComment: () => void; onSelectBeats: (ids: string[]) => void }) {
  const sel = useEditorState({
    editor,
    selector: ({ editor }) => {
      const { from, to, empty } = editor.state.selection
      // While typing (no selection) return the same value every time, so this bubble doesn't
      // re-render on each keystroke.
      if (empty || !editor.isFocused) return NO_SELECTION
      // Beats touched by the text selection (offer to select them for bulk editing).
      const beats: string[] = []
      editor.state.doc.nodesBetween(from, to, (n) => (n.type.name === 'beat' ? (beats.push(n.attrs.id), false) : true))
      return { from, to, empty, focused: true, beats: beats.join(' ') }
    },
  })
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const posRef = useRef(pos)

  useEffect(() => {
    // Only set state when the position really changes: a state update from this effect on every
    // keystroke piled up during fast typing and tripped React's update-depth limit.
    const next = (() => {
      if (!sel || sel.empty || !sel.focused) return null
      const scroller = ref.current?.parentElement
      if (!scroller) return posRef.current
      const start = editor.view.coordsAtPos(sel.from)
      const end = editor.view.coordsAtPos(sel.to)
      const box = scroller.getBoundingClientRect()
      return { top: Math.round(Math.min(start.top, end.top) - box.top + scroller.scrollTop - 46), left: Math.round(Math.max(90, (start.left + end.left) / 2 - box.left)) }
    })()
    const cur = posRef.current
    if (next === cur || (next && cur && next.top === cur.top && next.left === cur.left)) return
    posRef.current = next
    setPos(next)
  }, [sel, editor])

  return (
    <div ref={ref} className="bubble" style={pos ? { top: pos.top, left: pos.left } : { display: 'none' }} onMouseDown={(e) => e.preventDefault()}>
      {categories.map((c, i) => (
        <button key={c.id} className="bubble-swatch" style={{ background: c.color }} title={`${c.name}  (Alt+${i + 1})`} aria-label={`Annotate as ${c.name}`} onClick={() => onAnnotate(c.id)} />
      ))}
      <span className="bubble-sep" />
      <button className="icon-btn" title={tip('Comment', K.comment)} aria-label="Comment" onClick={onComment}>
        <MessageSquarePlus size={16} />
      </button>
      {sel && sel.beats.split(' ').length > 1 && (
        <>
          <span className="bubble-sep" />
          <button className="link-btn" onClick={() => onSelectBeats(sel.beats.split(' '))} title="Select these beats to change their data together">
            Select {sel.beats.split(' ').length} beats
          </button>
        </>
      )}
    </div>
  )
}

export type { Note, Thread }
