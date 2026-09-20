import { useState } from 'react'
import type { Bookmark, TagSuggestion } from '@shared/types'
import { Icon } from '../icons'
import { useStore } from '../store'
import { formatDateTime } from '../util'
import { CollectionSelect, Cover, Favicon, TagInput, TagSuggestions } from './ui'

export function Editor({ bookmark }: { bookmark: Bookmark }): React.JSX.Element {
  const s = useStore()
  const [title, setTitle] = useState(bookmark.title)
  const [url, setUrl] = useState(bookmark.url)
  const [note, setNote] = useState(bookmark.note)
  const [excerpt, setExcerpt] = useState(bookmark.excerpt)
  const [busy, setBusy] = useState(false)
  const inTrash = bookmark.deletedAt !== null

  // Tag suggestions on request (Suggest tags).
  const tagging = s.settings.tagging
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([])
  const [suggestStatus, setSuggestStatus] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)

  const suggest = async (): Promise<void> => {
    setSuggesting(true)
    setSuggestStatus(null)
    try {
      const result = await window.cairn.tagging.suggest({ bookmarkId: bookmark.id }, false)
      const have = new Set(bookmark.tags.map((t) => t.toLowerCase()))
      const fresh = result.suggestions.filter((sg) => !have.has(sg.tag.toLowerCase()))
      setSuggestions(fresh)
      setSuggestStatus(fresh.length === 0 ? 'No new suggestions for this bookmark.' : null)
    } catch {
      setSuggestStatus('Could not suggest tags.')
    } finally {
      setSuggesting(false)
    }
  }

  const commitText = async (field: 'title' | 'note' | 'excerpt', value: string): Promise<void> => {
    if (value === bookmark[field]) return
    await s.saveBookmark(bookmark.id, { [field]: value })
  }

  const commitUrl = async (): Promise<void> => {
    if (url.trim() === bookmark.url) return
    const saved = await s.saveBookmark(bookmark.id, { url })
    if (saved) setUrl(saved.url)
    else setUrl(bookmark.url)
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
