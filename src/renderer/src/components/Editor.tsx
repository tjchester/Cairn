import { useEffect, useRef, useState } from 'react'
import type { Bookmark, BookmarkPatch, TagSuggestion } from '@shared/types'
import { coerceUrl } from '@shared/url'
import { Icon } from '../icons'
import { useStore } from '../store'
import { formatDateTime } from '../util'
import { CollectionSelect, Cover, Favicon, TagInput, TagSuggestions } from './ui'

/** The four fields that are typed into; everything else is saved the moment it is changed. */
type TextFields = Pick<Bookmark, 'title' | 'url' | 'note' | 'excerpt'>

const textOf = (b: TextFields): TextFields => ({ title: b.title, url: b.url, note: b.note, excerpt: b.excerpt })

function isWebUrl(value: string): boolean {
  try {
    coerceUrl(value)
    return true
  } catch {
    return false
  }
}

export function Editor({ bookmark }: { bookmark: Bookmark }): React.JSX.Element {
  const s = useStore()
  const [title, setTitle] = useState(bookmark.title)
  const [url, setUrl] = useState(bookmark.url)
  const [note, setNote] = useState(bookmark.note)
  const [excerpt, setExcerpt] = useState(bookmark.excerpt)
  const [busy, setBusy] = useState(false)
  const inTrash = bookmark.deletedAt !== null

  // The pane follows the list, so it can be replaced at any moment (you click another bookmark, or close it).
  // `typed` is what is in the boxes now and `saved` is what has already been sent, so the difference between them
  // is what would otherwise be lost. Normally a click blurs the box first and that saves it; this catches the rest.
  const typed = useRef<TextFields>({ title, url, note, excerpt })
  typed.current = { title, url, note, excerpt }
  const saved = useRef<TextFields>(textOf(bookmark))
  useEffect(() => {
    saved.current = textOf(bookmark) // changed elsewhere (our own save coming back, a refresh, a tagging run)
  }, [bookmark.title, bookmark.url, bookmark.note, bookmark.excerpt])

  const id = bookmark.id
  useEffect(
    () => () => {
      const now = typed.current
      const before = saved.current
      const patch: BookmarkPatch = {}
      if (now.title !== before.title) patch.title = now.title
      if (now.note !== before.note) patch.note = now.note
      if (now.excerpt !== before.excerpt) patch.excerpt = now.excerpt
      // A half-typed address is not a link yet, so it is dropped rather than saved over a working one.
      if (now.url.trim() !== before.url && isWebUrl(now.url)) patch.url = now.url
      if (Object.keys(patch).length > 0) void useStore.getState().saveBookmark(id, patch)
    },
    [id]
  )

  // Tag suggestions on request (Suggest tags).
  const tagging = s.settings.tagging
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([])
  const [suggestStatus, setSuggestStatus] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)

  const [modelBusy, setModelBusy] = useState(false)

  const suggest = async (): Promise<void> => {
    setSuggesting(true)
    setSuggestStatus(null)
    const have = new Set(bookmark.tags.map((t) => t.toLowerCase()))
    const fresh = (list: TagSuggestion[]): TagSuggestion[] => list.filter((sg) => !have.has(sg.tag.toLowerCase()))
    const empty = 'No new suggestions for this bookmark.'
    try {
      const builtin = await window.cairn.tagging.suggest({ bookmarkId: bookmark.id }, false)
      setSuggestions(fresh(builtin.suggestions))
      const useModel = tagging.llm.enabled && tagging.llm.model !== ''
      setSuggestStatus(!useModel && fresh(builtin.suggestions).length === 0 ? empty : null)
      if (useModel) {
        setModelBusy(true)
        const withModel = await window.cairn.tagging.suggest({ bookmarkId: bookmark.id }, true)
        if (withModel.llm === 'used') {
          setSuggestions(fresh(withModel.suggestions))
          setSuggestStatus(fresh(withModel.suggestions).length === 0 ? empty : null)
        } else if (withModel.llm === 'failed') {
          setSuggestStatus('Local model unavailable: ' + (withModel.error ?? 'unknown error'))
        }
      }
    } catch {
      setSuggestStatus('Could not suggest tags.')
    } finally {
      setSuggesting(false)
      setModelBusy(false)
    }
  }

  const commitText = async (field: 'title' | 'note' | 'excerpt', value: string): Promise<void> => {
    if (value === bookmark[field]) return
    saved.current = { ...saved.current, [field]: value }
    await s.saveBookmark(bookmark.id, { [field]: value })
  }

  const commitUrl = async (): Promise<void> => {
    if (url.trim() === bookmark.url) return
    saved.current = { ...saved.current, url: url.trim() }
    const result = await s.saveBookmark(bookmark.id, { url })
    setUrl(result ? result.url : bookmark.url)
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    const updated = await s.refreshDetails(bookmark.id)
    if (updated) {
      setTitle(updated.title)
      setExcerpt(updated.excerpt)
    }
    setBusy(false)
  }

  return (
    <aside className="editor" aria-label="Edit bookmark">
      <header className="editor-header">
        <h2>Edit bookmark</h2>
        <button className="icon-btn" onClick={() => s.setEditing(null)} aria-label="Close editor" title="Close (Esc)">
          <Icon name="close" />
        </button>
      </header>

      <div className="editor-body">
        <Cover src={bookmark.coverUrl} />

        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void commitText('title', title)} maxLength={500} />
        </label>

        <label className="field">
          <span>
            <Favicon src={bookmark.faviconUrl} size={12} /> Link
          </span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => void commitUrl()}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            spellCheck={false}
            inputMode="url"
          />
        </label>

        <div className="field">
          <span>Collection</span>
          <CollectionSelect value={bookmark.collectionId} onChange={(id) => void s.saveBookmark(bookmark.id, { collectionId: id })} />
        </div>

        <div className="field">
          <span>Tags</span>
          <TagInput value={bookmark.tags} autoTags={bookmark.autoTags} onChange={(tags) => void s.saveBookmark(bookmark.id, { tags })} />
          {tagging.mode !== 'off' && !inTrash && (
            <>
              <button type="button" className="link-btn suggest-btn" onClick={() => void suggest()} disabled={suggesting}>
                <Icon name="sparkles" size={13} /> {suggesting ? 'Thinking…' : 'Suggest tags'}
              </button>
              <TagSuggestions
                suggestions={suggestions}
                taken={bookmark.tags}
                busy={modelBusy ? 'Asking ' + tagging.llm.model + '…' : null}
                status={suggestStatus}
                onPick={(pick) => {
                  setSuggestions((current) => current.filter((c) => c.tag !== pick.tag))
                  void s.saveBookmark(bookmark.id, { tags: [...bookmark.tags, pick.tag] })
                }}
              />
            </>
          )}
        </div>

        <label className="field">
          <span>Note</span>
          <textarea value={note} rows={4} onChange={(e) => setNote(e.target.value)} onBlur={() => void commitText('note', note)} placeholder="Add a private note…" />
        </label>

        <label className="field">
          <span>Description</span>
          <textarea value={excerpt} rows={3} onChange={(e) => setExcerpt(e.target.value)} onBlur={() => void commitText('excerpt', excerpt)} />
        </label>

        <dl className="facts">
          <dt>Added</dt>
          <dd>{formatDateTime(bookmark.createdAt)}</dd>
          <dt>Link status</dt>
          <dd>
            {bookmark.status === 'unknown' && 'Not checked'}
            {bookmark.status === 'ok' && (
              <span className="status ok">
                <Icon name="ok" size={12} /> Working
              </span>
            )}
            {bookmark.status === 'broken' && (
              <span className="status bad">
                <Icon name="unlink" size={12} /> Broken{bookmark.httpStatus ? ` (HTTP ${bookmark.httpStatus})` : ''}
              </span>
            )}
            {bookmark.lastCheckedAt && <span className="muted"> · {formatDateTime(bookmark.lastCheckedAt)}</span>}
          </dd>
        </dl>
      </div>

      <footer className="editor-footer">
        {inTrash ? (
          <>
            <button className="btn" onClick={() => void s.restoreIds([bookmark.id])}>
              <Icon name="undo" /> Restore
            </button>
            <button className="btn danger-text" onClick={() => void s.purgeIds([bookmark.id])}>
              <Icon name="remove" /> Delete permanently
            </button>
          </>
        ) : (
          <>
            <button className={`btn${bookmark.favorite ? ' on' : ''}`} onClick={() => void s.toggleFavorite([bookmark.id])} aria-pressed={bookmark.favorite}>
              <Icon name="favorite" /> {bookmark.favorite ? 'Favorited' : 'Favorite'}
            </button>
            <button className="btn" onClick={() => void s.openBookmark(bookmark)}>
              <Icon name="openLink" /> Open
            </button>
            <button className="btn" onClick={() => void s.copyLink(bookmark)}>
              <Icon name="copy" /> Copy
            </button>
            <button className="btn" onClick={() => void refresh()} disabled={busy} title="Fetch title, description and images again">
              <Icon name="refresh" /> {busy ? 'Fetching…' : 'Refresh'}
            </button>
            <button
              className="btn danger-text"
              onClick={async () => {
                s.setEditing(null)
                await s.trashIds([bookmark.id])
              }}
            >
              <Icon name="trash" /> Trash
            </button>
          </>
        )}
      </footer>
    </aside>
  )
}
