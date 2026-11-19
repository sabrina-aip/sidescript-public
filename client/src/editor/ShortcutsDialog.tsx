import { Fragment } from 'react'
import { Modal } from '../components/ui'
import { isMac, keyParts, SHORTCUT_GROUPS } from './shortcuts'

/** Keys as little key caps; words like "click" stay plain text. */
function Keys({ keys, mac }: { keys: string[]; mac: boolean }) {
  return (
    <span className="kbd-combo">
      {keyParts(keys, mac).map((k, i) => (
        <Fragment key={i}>
          {!mac && i > 0 && <span className="kbd-plus">+</span>}
          {/^[a-z]/.test(k) ? <span className="kbd-word">{k}</span> : <kbd>{k}</kbd>}
        </Fragment>
      ))}
    </span>
  )
}

function Cell({ alts, mac }: { alts: string[][]; mac: boolean }) {
  return (
    <td className={mac === isMac ? 'this-os' : ''}>
      {alts.map((k, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="kbd-or"> / </span>}
          <Keys keys={k} mac={mac} />
        </Fragment>
      ))}
    </td>
  )
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <table className="shortcuts">
        <thead>
          <tr>
            <th />
            <th className={isMac ? 'this-os' : ''}>Mac{isMac && <span className="muted"> · this computer</span>}</th>
            <th className={!isMac ? 'this-os' : ''}>Windows / Linux{!isMac && <span className="muted"> · this computer</span>}</th>
          </tr>
        </thead>
        {SHORTCUT_GROUPS.map((g) => (
          <tbody key={g.title}>
            <tr className="sc-group">
              <th colSpan={3}>{g.title}</th>
            </tr>
            {g.items.map((s) => (
              <tr key={s.action}>
                <td>
                  {s.action}
                  {s.note && <span className="muted small"> · {s.note}</span>}
                </td>
                <Cell alts={s.keys} mac />
                <Cell alts={s.keys} mac={false} />
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </Modal>
  )
}
