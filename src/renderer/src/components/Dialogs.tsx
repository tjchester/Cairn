import { useEffect, useState } from 'react'
import type { Bookmark, JobKind, LlmSettings, OllamaStatus, StartJobOptions, TagRunInfo, TaggingMode, ThemeSetting } from '@shared/types'
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

      <AutoTaggingSettings />

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

// ------------------------------------------------------------ Auto-tagging

const TAG_MODES: { value: TaggingMode; label: string; help: string }[] = [
  { value: 'off', label: 'Off', help: 'No tag suggestions.' },
  { value: 'suggest', label: 'Suggest', help: 'Shows suggested tags when you add or edit a bookmark; you click the ones you want.' },
  { value: 'auto', label: 'Auto', help: 'Also adds them for you when you add a bookmark. Automatic tags are marked so you can review or remove them.' }
]

const RULES_PLACEHOLDER = '{\n  "domains": { "example.com": ["my-tag"] },\n  "topics": { "gardening": ["allotment", "raised bed"] }\n}'

function AutoTaggingSettings(): React.JSX.Element {
  const s = useStore()
  const tagging = s.settings.tagging
  const [rules, setRules] = useState(tagging.userRules)

  return (
    <section className="settings-section">
      <h3>
        <Icon name="sparkles" /> Auto-tagging
      </h3>
      <p className="muted">
        Suggests tags from a page&apos;s site, address, keywords and text, reusing the tags you already have so your tag list doesn&apos;t sprawl.
        This all happens on your computer.
      </p>
      <div className="segmented wide" role="group" aria-label="Auto-tagging mode">
        {TAG_MODES.map((m) => (
          <button key={m.value} className={tagging.mode === m.value ? 'active' : ''} aria-pressed={tagging.mode === m.value} onClick={() => void s.updateSettings({ tagging: { mode: m.value } })}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="muted settings-note">{TAG_MODES.find((m) => m.value === tagging.mode)?.help}</p>

      <label className="field inline">
        <span>Most tags suggested per bookmark</span>
        <select value={tagging.maxTags} onChange={(e) => void s.updateSettings({ tagging: { maxTags: Number(e.target.value) } })} aria-label="Most tags per bookmark">
          {[1, 2, 3, 4, 5, 6, 8].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <details className="rules">
        <summary>Custom rules (advanced)</summary>
        <p className="muted settings-note">
          Add your own knowledge on top of the built-in rules, as JSON. Sections: <code>domains</code>, <code>topics</code>, <code>pathSegments</code>, <code>extensions</code>,{' '}
          <code>tlds</code>, <code>hostPrefixes</code>, <code>ogTypes</code>.
        </p>
        <textarea
          className="mono"
          rows={6}
          spellCheck={false}
          value={rules}
          placeholder={RULES_PLACEHOLDER}
          onChange={(e) => setRules(e.target.value)}
          onBlur={() => rules !== tagging.userRules && void s.updateSettings({ tagging: { userRules: rules } })}
          aria-label="Custom tagging rules"
        />
      </details>

      <LocalModelSettings />
    </section>
  )
}

/** Optional: a local Ollama model that improves suggestions. Off by default; nothing is sent anywhere until enabled. */
function LocalModelSettings(): React.JSX.Element {
  const s = useStore()
  const llm = s.settings.tagging.llm
  const [address, setAddress] = useState(llm.baseUrl)
  const [instructions, setInstructions] = useState(llm.instructions)
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [checking, setChecking] = useState(false)

  const check = async (overrides: Partial<LlmSettings> = {}): Promise<void> => {
    setChecking(true)
    try {
      setStatus(await api.tagging.ollama.status(overrides))
    } finally {
      setChecking(false)
    }
  }
  const save = (patch: Partial<LlmSettings>): Promise<void> => s.updateSettings({ tagging: { llm: patch } })

  // Look up the installed models (and whether the chosen one is ready) whenever the model is switched on or its
  // address or model changes.
  useEffect(() => {
    if (llm.enabled) void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llm.enabled, llm.baseUrl, llm.allowRemote, llm.model])

  const models = status?.models ?? []
  const choices = llm.model && !models.includes(llm.model) ? [llm.model, ...models] : models

  return (
    <div className="llm-settings">
      <h4>
        <Icon name="sparkles" size={14} /> Local AI model (optional)
      </h4>
      <label className="check">
        <input type="checkbox" checked={llm.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        <span>Use a local model through Ollama to improve suggestions</span>
      </label>
      <p className="muted settings-note">
        {llm.allowRemote
          ? 'Bookmark titles, links and descriptions are sent to the server below. Private notes are never sent.'
          : 'Runs on this computer: bookmark titles, links and descriptions go to your own Ollama, nothing else leaves it. Private notes are never sent.'}
      </p>

      {llm.enabled && (
        <>
          <label className="field">
            <span>Ollama address</span>
            <input
              value={address}
              spellCheck={false}
              onChange={(e) => setAddress(e.target.value)}
              onBlur={() => address.trim() !== llm.baseUrl && void save({ baseUrl: address.trim() })}
              aria-label="Ollama address"
            />
          </label>

          <label className="field">
            <span>Model</span>
            <select value={llm.model} onChange={(e) => void save({ model: e.target.value })} aria-label="Model">
              <option value="">{choices.length === 0 ? 'No models found' : 'Choose a model…'}</option>
              {choices.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <div className="button-row">
            <button className="btn" disabled={checking} onClick={() => void check({ baseUrl: address.trim(), model: llm.model })}>
              <Icon name="refresh" /> {checking ? 'Checking…' : 'Test connection'}
            </button>
            {status && (
              <span className={'llm-status' + (status.ok && (status.modelReady || !llm.model) ? ' ok' : ' bad')} role="status">
                <Icon name={status.ok && (status.modelReady || !llm.model) ? 'ok' : 'warning'} size={14} /> {status.message}
              </span>
            )}
          </div>

          <label className="check">
            <input type="checkbox" checked={llm.sendPageText} onChange={(e) => void save({ sendPageText: e.target.checked })} />
            <span>Also send the first part of each page&apos;s text (more accurate, but sends more of the page)</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={llm.allowRemote} onChange={(e) => void save({ allowRemote: e.target.checked })} />
            <span>Allow a server on another computer (its address is then trusted with your bookmark titles and links)</span>
          </label>

          <label className="field">
            <span>Extra instructions (optional)</span>
            <textarea
              rows={2}
              value={instructions}
              placeholder="e.g. Prefer broad topics over product names."
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={() => instructions !== llm.instructions && void save({ instructions })}
              aria-label="Extra instructions for the model"
            />
          </label>
        </>
      )}
    </div>
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

function JobPanel({
  kind,
  title,
  description,
  actionLabel,
  options,
  disabled,
  children
}: {
  kind: JobKind
  title: string
  description: string
  actionLabel: string
  options?: StartJobOptions
  disabled?: boolean
  children?: React.ReactNode
}) {
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
          <button className="btn primary" onClick={() => void s.startJob(kind, options)} disabled={disabled || (s.job !== null && !s.job.finished)}>
            {actionLabel}
          </button>
          {job?.finished && <span className="muted">{job.cancelled ? 'Cancelled' : 'Done'}: {job.summary}</span>}
        </div>
      )}
      {children}
    </section>
  )
}

function AutoTagPanel(): React.JSX.Element {
  const s = useStore()
  const [lastRun, setLastRun] = useState<TagRunInfo | null>(null)
  const [useModel, setUseModel] = useState(false)
  const modelReady = s.settings.tagging.llm.enabled && s.settings.tagging.llm.model !== ''
  const jobKey = s.job ? s.job.id + ':' + s.job.finished : ''
  useEffect(() => void api.tagging.runs.last().then(setLastRun), [jobKey, s.pendingProposals])
  const mode = s.settings.tagging.mode
  const busy = s.job !== null && !s.job.finished

  const description =
    mode === 'off'
      ? 'Auto-tagging is turned off. Turn it on in Settings to use this.'
      : mode === 'suggest'
        ? 'Suggests tags for your bookmarks and queues them for you to review. Nothing changes until you accept a suggestion.'
        : 'Adds tags to your bookmarks right away, marked as automatic. You can undo the whole run.'

  const undo = async (): Promise<void> => {
    if (!lastRun) return
    const removed = await api.tagging.runs.undo(lastRun.id)
    s.toast('Removed ' + removed + ' automatic tag' + (removed === 1 ? '' : 's'), 'success')
    await s.refreshAll()
    setLastRun(await api.tagging.runs.last())
  }

  const removeAll = async (): Promise<void> => {
    const yes = await s.confirm({
      title: 'Remove all automatic tags?',
      message: 'Every tag added automatically is removed from your bookmarks. Tags you added yourself stay.',
      confirmLabel: 'Remove automatic tags',
      danger: true
    })
    if (!yes) return
    const removed = await api.tagging.runs.removeAuto()
    s.toast('Removed ' + removed + ' automatic tag' + (removed === 1 ? '' : 's'), 'success')
    await s.refreshAll()
  }

  return (
    <JobPanel kind="auto-tag" title="Auto-tag bookmarks" description={description} actionLabel="Auto-tag untagged bookmarks" options={{ scope: 'untagged', useLlm: modelReady && useModel }} disabled={mode === 'off'}>
      {modelReady && mode !== 'off' && (
        <label className="check">
          <input type="checkbox" checked={useModel} onChange={(e) => setUseModel(e.target.checked)} />
          <span>Also use the local model ({s.settings.tagging.llm.model}): slower, expect a few seconds per bookmark, and it can be stopped and resumed</span>
        </label>
      )}
      <div className="button-row auto-tag-extra">
        <button
          className="btn"
          disabled={mode === 'off' || busy}
          onClick={async () => {
            const yes = await s.confirm({
              title: 'Auto-tag all bookmarks?',
              message: 'This includes bookmarks that already have tags. Tags they have are kept; new ones are ' + (mode === 'auto' ? 'added' : 'suggested for review') + '.',
              confirmLabel: 'Auto-tag all'
            })
            if (yes) await s.startJob('auto-tag', { scope: 'all', useLlm: modelReady && useModel })
          }}
        >
          Auto-tag all bookmarks
        </button>
        <button className="btn" disabled={s.pendingProposals === 0} onClick={() => s.openDialog({ type: 'review-tags' })}>
          <Icon name="sparkles" /> Review suggestions{s.pendingProposals > 0 ? ' (' + s.pendingProposals + ')' : ''}
        </button>
        <button className="btn" disabled={!lastRun || busy} onClick={() => void undo()} title={lastRun ? 'Removes the tags added by the last run' : 'Nothing to undo'}>
          <Icon name="undo" /> Undo last run{lastRun ? ' (' + lastRun.tagsApplied + ' tags)' : ''}
        </button>
        <button className="btn danger-text" disabled={busy} onClick={() => void removeAll()}>
          Remove all automatic tags
        </button>
      </div>
    </JobPanel>
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
        title="Fetch missing details"
        description="Downloads the title, description, cover image, site icon and page keywords (used for tag suggestions) for bookmarks that haven't been fetched yet, for example after an import, and retries the ones that failed."
        actionLabel="Fetch missing details"
      />
      <AutoTagPanel />
    </Modal>
  )
}
