/**
 * Every keyboard shortcut, in one list: the Keyboard shortcuts dialog and the tooltips
 * read from here, so they always match what the keys do and show ⌘/⌥/⇧ on a Mac.
 *
 * Keys are written as parts: 'Mod' is ⌘ on a Mac and Ctrl elsewhere; 'Alt' is ⌥ / Alt.
 * Words such as 'click' are shown as plain text.
 */
export const isMac =
  typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test([(navigator as any).userAgentData?.platform, navigator.platform, navigator.userAgent].filter(Boolean).join(' '))

type Keys = string[]
export interface Shortcut {
  action: string
  keys: Keys[] // alternatives
  note?: string
}

const MAC: Record<string, string> = { Mod: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃', Enter: '↩', Backspace: '⌫', Delete: '⌦', Esc: 'Esc', Up: '↑', Down: '↓' }
const PC: Record<string, string> = { Mod: 'Ctrl', Up: '↑', Down: '↓' }
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod']

/** Parts for display on one platform, e.g. ['⌘', '⇧', '.'] or ['Ctrl', 'Shift', '.']. */
export function keyParts(keys: Keys, mac = isMac): string[] {
  if (!mac) return keys.map((k) => PC[k] ?? k)
  const mods = keys.filter((k) => MAC_ORDER.includes(k)).sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b))
  return [...mods, ...keys.filter((k) => !MAC_ORDER.includes(k))].map((k) => MAC[k] ?? k)
}

/** "⌘⇧." on a Mac, "Ctrl+Shift+." elsewhere. */
export function keyLabel(keys: Keys, mac = isMac) {
  const parts = keyParts(keys, mac)
  if (!mac) return parts.join('+')
  // Mac style: modifier symbols run together, then the key (with a space before a word like "click").
  return parts.reduce((s, p, i) => s + (i && /^[a-z]/.test(p) ? ' ' : '') + p, '')
}

/** Tooltip text: "Bold (⌘B)". */
export const tip = (label: string, keys: Keys) => `${label} (${keyLabel(keys)})`

// The keys, by name, for tooltips and hints elsewhere in the app.
export const K = {
  undo: ['Mod', 'Z'],
  redo: ['Mod', 'Shift', 'Z'],
  bold: ['Mod', 'B'],
  italic: ['Mod', 'I'],
  underline: ['Mod', 'U'],
  strike: ['Mod', 'Shift', 'S'],
  code: ['Mod', 'E'],
  bigger: ['Mod', 'Shift', '.'],
  smaller: ['Mod', 'Shift', ','],
  alignLeft: ['Mod', 'Shift', 'L'],
  alignCenter: ['Mod', 'Shift', 'E'],
  alignRight: ['Mod', 'Shift', 'R'],
  bullets: ['Mod', 'Shift', '8'],
  numbers: ['Mod', 'Shift', '7'],
  checklist: ['Mod', 'Shift', '9'],
  quote: ['Mod', 'Shift', 'B'],
  comment: ['Mod', 'Alt', 'M'],
  annotate: (n: number) => ['Alt', String(n)],
  newBeat: ['Mod', 'Enter'],
  newSection: ['Mod', 'Shift', 'Enter'],
  done: ['Mod', 'Enter'],
  print: ['Mod', 'P'],
  shortcuts: ['Mod', '/'],
  hideMenus: ['Mod', 'Shift', 'F'],
} satisfies Record<string, Keys | ((n: number) => Keys)>

export const SHORTCUT_GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: 'Script structure',
    items: [
      { action: 'Split into a new beat at the cursor', keys: [K.newBeat] },
      { action: 'Start a new section here', keys: [K.newSection] },
      { action: 'New line in the same beat', keys: [['Enter']] },
      { action: 'Line break without a new paragraph', keys: [['Shift', 'Enter']] },
      { action: 'Merge into the beat above', keys: [['Backspace']], note: 'at the start of a beat' },
      { action: 'Move a beat or section up / down', keys: [['Alt', 'Up'], ['Alt', 'Down']], note: 'in the Outline' },
    ],
  },
  {
    title: 'Text',
    items: [
      { action: 'Bold', keys: [K.bold] },
      { action: 'Italic', keys: [K.italic] },
      { action: 'Underline', keys: [K.underline] },
      { action: 'Strikethrough', keys: [K.strike] },
      { action: 'Inline code', keys: [K.code] },
      { action: 'Checklist / bulleted / numbered list', keys: [K.checklist, K.bullets, K.numbers] },
      { action: 'Quote', keys: [K.quote] },
      { action: 'Align left / centre / right', keys: [K.alignLeft, K.alignCenter, K.alignRight] },
    ],
  },
  {
    title: 'Annotations & comments',
    items: [
      { action: 'Annotate the selection with layer 1–9', keys: [['Alt', '1…9']], note: 'in the order shown in Label Options' },
      { action: 'Comment on the selection', keys: [K.comment] },
      { action: 'Finish an annotation (Done)', keys: [K.done], note: 'in its note box' },
      { action: 'Show only one layer', keys: [['double-click'], ['Alt', 'click']], note: 'on a layer in the bar' },
    ],
  },
  {
    title: 'Editing',
    items: [
      { action: 'Undo (text and beat data)', keys: [K.undo] },
      { action: 'Redo', keys: [K.redo, ['Mod', 'Y']] },
      { action: 'Select a range of beats', keys: [['Shift', 'click']], note: 'on beat checkboxes or in the Outline' },
      { action: 'Add or remove one beat', keys: [['Mod', 'click']], note: 'in the Outline' },
      { action: 'Clear the beat selection', keys: [['Esc']] },
    ],
  },
  {
    title: 'Document',
    items: [
      { action: 'Print / download as PDF', keys: [K.print] },
      { action: 'Keyboard shortcuts', keys: [K.shortcuts] },
      { action: 'Hide / show the menus', keys: [K.hideMenus] },
      { action: 'Leave full screen', keys: [['Esc']] },
    ],
  },
]
