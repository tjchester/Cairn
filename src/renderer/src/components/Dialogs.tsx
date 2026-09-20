import { useEffect, useState } from 'react'
import type { Bookmark, ThemeSetting } from '@shared/types'
import { Icon } from '../icons'
import { useStore } from '../store'
import { formatDate } from '../util'
import { Favicon, Modal } from './ui'

const api = window.cairn

// ---------------------------------------------------------------- Settings

export function SettingsDialog(): React.JSX.Element {
  const s = useStore()
  const [version, setVersion] = useState('')
  useEffect(() => void api.app.version().then(setVersion), [])

  const themes: { value: ThemeSetting; label: string }[] = [
    { value: 'system', label: 'Match system' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' }
  ]

  return (
    <Modal title="Settings" onClose={() => s.closeDialog()} width={520}>
      <section className="settings-section">
        <h3>
          <Icon name="theme" /> Appearance
        </h3>
        <div className="segmented wide" role="group" aria-label="Theme">
          {themes.map((t) => (
            <button key={t.value} className={s.settings.theme === t.value ? 'active' : ''} aria-pressed={s.settings.theme === t.value} onClick={() => void s.updateSettings({ theme: t.value })}>
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h3>
          <Icon name="import" /> Import &amp; export
        </h3>
        <p className="muted">Bring bookmarks in from any browser (HTML), a CSV spreadsheet, or a Cairn backup. Everything stays on this computer.</p>
        <div className="button-row">
          <button className="btn" onClick={() => void s.importFile()}>
            <Icon name="import" /> Import…
          </button>
          <button className="btn" onClick={() => void s.exportFile('html')}>
            <Icon name="export" /> Browser HTML
          </button>
          <button className="btn" onClick={() => void s.exportFile('csv')}>
            <Icon name="export" /> CSV
          </button>
          <button className="btn" onClick={() => void s.exportFile('json')}>
            <Icon name="export" /> Backup (JSON)
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>
          <Icon name="info" /> About
        </h3>
        <p>
          <strong>Cairn</strong> {version && <span className="muted">v{version}</span>} — a local-first bookmark manager. Released under the MIT License.
        </p>
        <p className="muted">Interface icons: Tabler Icons (MIT License).</p>
        <div className="button-row">
          <button className="btn" onClick={() => void api.app.showLegal()}>
            Licenses
          </button>
          <button className="btn" onClick={() => s.openDialog({ type: 'shortcuts' })}>
            <Icon name="keyboard" /> Keyboard shortcuts
          </button>
        </div>
      </section>
    </Modal>
  )
}

// --------------------------------------------------------------- Shortcuts

const SHORTCUTS: [string, string][] = [
  ['Ctrl/⌘ + N', 'New bookmark'],
  ['Ctrl/⌘ + Shift + N', 'New collection'],
  ['Ctrl/⌘ + F  or  /', 'Search'],
  ['Ctrl/⌘ + B', 'Toggle sidebar'],
  ['Ctrl/⌘ + 1 / 2 / 3', 'List / grid / headlines layout'],
  ['Ctrl/⌘ + Shift + I', 'Import bookmarks'],
  ['Ctrl/⌘ + Shift + T', 'Duplicates & broken links'],
  ['↑ / ↓', 'Move selection'],
  ['Shift + click', 'Select a range'],
  ['Ctrl/⌘ + click', 'Add to selection'],
  ['Ctrl/⌘ + A', 'Select all loaded bookmarks'],
  ['Enter', 'Open selected bookmark in the browser'],
  ['E', 'Edit selected bookmark'],
  ['F', 'Toggle favorite'],
  ['Delete', 'Move selection to Trash'],
  ['Esc', 'Close panel / clear selection'],
  ['Paste a URL', 'Add it as a bookmark (anywhere in the window)']
]

export function ShortcutsDialog(): React.JSX.Element {
  const close = useStore((s) => s.closeDialog)
  return (
    <Modal title="Keyboard shortcuts" onClose={() => close()} width={480}>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}

// ------------------------------------------------------------------- Tools

function JobPanel({ kind, title, description, actionLabel }: { kind: 'check-links' | 'fetch-metadata'; title: string; description: string; actionLabel: string }) {
  const s = useStore()
  const job = s.job && s.job.kind === kind ? s.job : null
  const running = job !== null && !job.finished
  const percent = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      <p className="muted">{description}</p>
      {running ? (
        <>
          <div className="progress-row">
            <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={title}>
              <div style={{ width: `${percent}%` }} />
            </div>
            <span className="muted">
              {job.done} / {job.total}
            </span>
            <button className="btn" onClick={() => void s.cancelJob()}>
              <Icon name="stop" /> Cancel
            </button>
          </div>
          {job.note && (
            <p className={`job-note${job.paused ? ' paused' : ''}`} role="status">
              <Icon name={job.paused ? 'warning' : 'info'} size={14} /> {job.note}
            </p>
          )}
        </>
      ) : (
        <div className="button-row">
          <button className="btn primary" onClick={() => void s.startJob(kind)} disabled={s.job !== null && !s.job.finished}>
            {actionLabel}
          </button>
          {job?.finished && <span className="muted">{job.cancelled ? 'Cancelled' : 'Done'}: {job.summary}</span>}
        </div>
      )}
    </section>
  )
}

function Duplicates(): React.JSX.Element {
  const s = useStore()
  const [groups, setGroups] = useState<Bookmark[][] | null>(null)
  const [scanning, setScanning] = useState(false)
  const collections = s.collections

  const scan = async (): Promise<void> => {
    setScanning(true)
    try {
      setGroups(await api.tools.findDuplicates())
    } finally {
      setScanning(false)
    }
  }
  useEffect(() => void scan(), [])

  const trash = async (ids: number[]): Promise<void> => {
    await s.trashIds(ids)
    await scan()
  }

  const extraCopies = (groups ?? []).flatMap((g) => g.slice(1).map((b) => b.id))

  return (
    <section className="settings-section">
      <h3>
        <Icon name="duplicate" /> Duplicate bookmarks
      </h3>
      <p className="muted">Bookmarks that point to the same page (ignoring http/https, “www”, trailing slashes and tracking parameters).</p>
      {groups === null || scanning ? (
        <p className="muted">Scanning…</p>
      ) : groups.length === 0 ? (
        <p className="ok-text">
          <Icon name="ok" /> No duplicates found.
        </p>
      ) : (
        <>
          <div className="button-row">
            <button className="btn primary" onClick={() => void trash(extraCopies)}>
              Keep the oldest of each, trash {extraCopies.length} extra
            </button>
          </div>
          <ul className="dupe-groups">
            {groups.map((group) => (
              <li key={group[0]?.id}>
                <div className="dupe-url">{group[0]?.url}</div>
                <ul>
                  {group.map((b, i) => (
                    <li key={b.id}>
                      <Favicon src={b.faviconUrl} size={14} />
                      <span className="dupe-title">{b.title}</span>
                      <span className="muted">
                        {b.collectionId === null ? 'Unsorted' : (collections.find((c) => c.id === b.collectionId)?.name ?? '')} · {formatDate(b.createdAt)}
                        {i === 0 ? ' · oldest' : ''}
                      </span>
                      <button className="btn small" onClick={() => void trash([b.id])}>
                        Trash
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

export function ToolsDialog(): React.JSX.Element {
  const s = useStore()
  return (
    <Modal title="Duplicates & broken links" onClose={() => s.closeDialog()} width={640}>
      <Duplicates />
      <JobPanel
        kind="check-links"
        title="Check for broken links"
        description="Visits every bookmark once and flags pages that no longer exist. This contacts each website."
        actionLabel="Check all links"
      />
      {s.counts.broken > 0 && (
        <div className="button-row tight">
          <button
            className="btn"
            onClick={() => {
              s.closeDialog()
              s.setScope({ kind: 'broken' })
            }}
          >
            <Icon name="unlink" /> Show {s.counts.broken} broken {s.counts.broken === 1 ? 'link' : 'links'}
          </button>
        </div>
      )}
      <JobPanel
        kind="fetch-metadata"
        title="Fetch missing covers & icons"
        description="Downloads preview images, descriptions and site icons for bookmarks that don't have them yet (useful after an import)."
        actionLabel="Fetch missing details"
      />
    </Modal>
  )
}
