import StarterKit from '@tiptap/starter-kit'
import Heading from '@tiptap/extension-heading'
import CodeBlock from '@tiptap/extension-code-block'
import TextAlign from '@tiptap/extension-text-align'
import Image from '@tiptap/extension-image'
import { TextStyle } from '@tiptap/extension-text-style'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Annotation, Comment } from './marks'
import { Font } from './fonts'
import { Spacing } from './spacing'
import { Beat, ScriptDocument, Section, SectionTitleWithView } from '../script/nodes'
import type { ScriptContext } from '../script/context'

/** Schema shared by the live editor and read-only previews. `ctx` enables the interactive beat views. */
export const baseExtensions = (ctx: ScriptContext | null = null) => [
  StarterKit.configure({
    document: false,
    undoRedo: false,
    heading: false,
    codeBlock: false,
    link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } },
  }),
  // Scripts don't use headings or code blocks (sections are the structure). The node types stay
  // only so text in older scripts still shows (an editor that doesn't know a node type deletes
  // it when syncing); nothing creates them any more: no shortcuts, no "# " or ``` typing, and
  // pasted headings / code blocks come in as normal paragraphs.
  Heading.extend({ addKeyboardShortcuts: () => ({}), addInputRules: () => [], parseHTML: () => [] }),
  CodeBlock.extend({ addKeyboardShortcuts: () => ({}), addInputRules: () => [], parseHTML: () => [] }),
  ScriptDocument,
  Section.configure({ ctx }),
  SectionTitleWithView.configure({ ctx }),
  Beat.configure({ ctx }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  // Checklists (new node types: PROTOCOL_VERSION 3 keeps older tabs from deleting them).
  TaskList,
  TaskItem.configure({ nested: true }),
  Image.configure({ allowBase64: false }),
  TextStyle,
  Font,
  Spacing,
  Annotation,
  Comment,
]
