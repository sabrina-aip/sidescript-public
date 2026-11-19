/** Adding, renaming and deleting table columns (done from the table's header row). */
import { api } from '../api'
import { toast } from '../util'
import { confirmAt } from '../components/confirmAt'
import { nextColor } from '../editor/model'
import type { ScriptContext } from './context'
import { MAX_FIELDS, type FieldDef, type FieldType } from './fields'

const rid = () => Math.random().toString(36).slice(2, 8)

export function renameColumn(script: ScriptContext, fields: FieldDef[], id: string, name: string) {
  const clean = name.slice(0, 40)
  if (id === 'dialogue') script.transact(() => script.fields.set('dialogueName', clean))
  else script.transact(() => script.fields.set('list', fields.map((f) => (f.id === id ? { ...f, name: clean } : f))))
}

export function addColumn(script: ScriptContext, fields: FieldDef[], type: FieldType) {
  if (fields.length >= MAX_FIELDS) return
  if (type === 'visual' && fields.some((f) => f.type === 'visual')) type = 'text'
  const name = type === 'visual' ? 'Visual' : type === 'select' ? 'New chips' : 'New column'
  const field: FieldDef = { id: rid(), name, type, ...(type === 'text' ? {} : { options: [{ id: rid(), label: 'Option', color: nextColor(type, []) }] }) }
  script.transact(() => script.fields.set('list', [...fields, field]))
  return field.id
}

/** Destructive: saves a version first, and is deliberately outside Ctrl+Z (restore from Version history). */
export async function deleteColumn(script: ScriptContext, fields: FieldDef[], f: FieldDef, anchor?: HTMLElement) {
  const ok = await confirmAt(anchor, {
    title: `Delete the “${f.name}” column?`,
    message: 'Its contents are removed from every beat. Ctrl+Z can’t bring it back, but a version is saved first, so you can restore it from Version history.',
    confirm: 'Delete column',
    danger: true,
  })
  if (!ok) return
  try {
    await api('POST', `/api/docs/${script.docId}/history`, { label: `before deleting ${f.name} column` })
  } catch (e: any) {
    return void toast(`Couldn't save a version first, so nothing was deleted (${e.message})`, 'error')
  }
  script.fields.doc!.transact(() => {
    script.fields.set('list', fields.filter((x) => x.id !== f.id))
    const widths = { ...(script.fields.get('widths') || {}) }
    delete widths[f.id]
    script.fields.set('widths', widths)
    script.beats.forEach((data) => data.delete(f.id))
  }, 'sidescript-structure')
  toast(`Deleted the “${f.name}” column. A version was saved first.`)
}
