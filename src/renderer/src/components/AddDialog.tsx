import { useEffect, useMemo, useState } from 'react'
import type { Bookmark, PageMetadata } from '@shared/types'
import { coerceUrl, extractUrls } from '@shared/url'
import { Icon } from '../icons'
import { useStore } from '../store'
import { errorMessage } from '../util'
import { CollectionSelect, Cover, Favicon, Modal, TagInput } from './ui'

const api = window.cairn

type MetaState = 'idle' | 'loading' | 'done' | 'failed'

export function AddDialog({ initialUrls }: { initialUrls?: string[] }): React.JSX.Element {
  const s = useStore()
  const close = s.closeDialog

  const defaultCollection = s.scope.kind === 'collection' ? s.scope.id : null
  const defaultTags = s.scope.kind === 'tag' ? [s.scope.name] : []

  const [bulk, setBulk] = useState<string[]>(initialUrls && initialUrls.length > 1 ? initialUrls : [])
  const [url, setUrl] = useState(initialUrls?.length === 1 ? (initialUrls[0] as string) : '')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [collectionId, setCollectionId] = useState<number | null>(defaultCollection)
  const [tags, setTags] = useState<string[]>(defaultTags)
  const [meta, setMeta] = useState<PageMetadata | null>(null)
  const [metaState, setMetaState] = useState<MetaState>('idle')
  const [existing, setExisting] = useState<Bookmark | null>(null)
  const [saving, setSaving] = useState(false)

  const normalized = useMemo(() => {
    try {
      return url.trim() ? coerceUrl(url) : null
    } catch {
      return null
    }
  }, [url])

  // Look up page details (and any existing copy) shortly after the URL settles.
  useEffect(() => {
    setMeta(null)
    setExisting(null)
    if (!normalized) {
      setMetaState('idle')
      return
    }
    let cancelled = false
    setMetaState('loading')
    const timer = setTimeout(() => {
      void api.bookmarks.findByUrl(normalized).then((hit) => !cancelled && setExisting(hit)).catch(() => undefined)
      api.metadata
        .fetch(normalized)
        .then((result) => {
          if (cancelled) return
          setMeta(result)
          setMetaState('done')
          setTitle((current) => current || result.title)
        })
        .catch(() => !cancelled && setMetaState('failed'))
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [normalized])

  const onPaste = (e: React.ClipboardEvent): void => {
    const found = extractUrls(e.clipboardData.getData('text'))
    if (found.length > 1) {
      e.preventDefault()
      setBulk(found)
    }
  }

  const saveSingle = async (): Promise<void> => {
    if (!normalized) return
    setSaving(true)
    try {
      const created = await api.bookmarks.create({
        url: normalized,
        title: title.trim() || meta?.title || undefined,
        note,
        excerpt: meta?.excerpt,
        coverUrl: meta?.coverUrl,
        faviconUrl: meta?.faviconUrl,
        collectionId,
        tags
      })
      close()
      s.toast('Bookmark saved', 'success')
      await s.refreshAll()
      if (metaState !== 'done') {
        // The page was still loading (or unreachable): try once more in the background.
        void api.bookmarks.refreshMetadata(created.id).then(() => s.refreshAll()).catch(() => undefined)
      }
    } catch (error) {
      s.toast(errorMessage(error), 'error')
      setSaving(false)
    }
  }

  const saveBulk = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await api.bookmarks.createMany(bulk.map((u) => ({ url: u, collectionId, tags })))
      close()
      s.toast(`Added ${result.created} bookmark${result.created === 1 ? '' : 's'}${result.skipped ? `, skipped ${result.skipped} already saved` : ''}`, 'success')
      await s.refreshAll()
      if (result.created > 0) await s.startJob('fetch-metadata')
    } catch (error) {
      s.toast(errorMessage(error), 'error')
      setSaving(false)
    }
  }

  const isBulk = bulk.length > 1

  return (
    <Modal
      title={isBulk ? `Add ${bulk.length} bookmarks` : 'Add bookmark'}
      onClose={() => close()}
      width={520}
      footer={
        <>
          <button className="btn" onClick={() => close()}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving || (isBulk ? false : !normalized)} onClick={() => void (isBulk ? saveBulk() : saveSingle())}>
            {saving ? 'Saving…' : isBulk ? `Add ${bulk.length} bookmarks` : 'Save'}
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (!saving && (isBulk || normalized)) void (isBulk ? saveBulk() : saveSingle())
        }}
      >
        {isBulk ? (
          <div className="field">
            <span>Links</span>
            <ul className="url-list">
              {bulk.map((u) => (
                <li key={u}>
                  <Icon name="link" size={12} /> {u}
                </li>
              ))}
            </ul>
            <button type="button" className="link-btn" onClick={() => (setBulk([]), setUrl(''))}>
              Add a single link instead
            </button>
          </div>
        ) : (
          <>
            <label className="field">
              <span>Link</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onPaste={onPaste}
                placeholder="Paste a link, e.g. example.com/article"
                inputMode="url"
                spellCheck={false}
                autoFocus
                aria-invalid={url.trim() !== '' && !normalized}
              />
              {url.trim() !== '' && !normalized && <em className="hint bad">That doesn’t look like a web address.</em>}
              {existing && (
                <em className="hint warn">
                  <Icon name="warning" size={12} /> Already saved as “{existing.title}”. Saving adds another copy.
                </em>
              )}
            </label>

            {normalized && (
              <div className="preview">
                <Cover src={meta?.coverUrl ?? null} />
                <div className="preview-text">
                  <div className="preview-title">
                    <Favicon src={meta?.faviconUrl ?? null} size={14} />
                    <span>{metaState === 'loading' ? 'Fetching page details…' : meta?.title || (metaState === 'failed' ? 'Couldn’t reach that page. You can still save it.' : normalized)}</span>
                  </div>
                  {meta?.excerpt && <p>{meta.excerpt}</p>}
                </div>
              </div>
            )}

            <label className="field">
              <span>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={meta?.title || 'Optional'} maxLength={500} />
            </label>
          </>
        )}

        <div className="field">
          <span>Collection</span>
          <CollectionSelect value={collectionId} onChange={setCollectionId} />
        </div>

        <div className="field">
          <span>Tags</span>
          <TagInput value={tags} onChange={setTags} />
        </div>

        {!isBulk && (
          <label className="field">
            <span>Note</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Optional private note" />
          </label>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
