import { Fragment, memo, useEffect, useMemo, useRef, type DragEvent } from 'react'
import type { Bookmark, Scope, ViewMode } from '@shared/types'
import { Icon } from '../icons'
import { useStore, type ContextItem } from '../store'
import { archivedCollectionIds, buildTree, collectionChain, flattenTree } from '@shared/collections'
import { BOOKMARK_DRAG_TYPE, formatDate } from '../util'
import { Cover, Favicon } from './ui'

interface RowProps {
  bookmark: Bookmark
  view: ViewMode
  selected: boolean
  editing: boolean
  inTrash: boolean
}

function useRowActions() {
  const s = useStore.getState

  const contextIds = (bookmark: Bookmark): number[] => {
    const { selected } = s()
    return selected.has(bookmark.id) ? [...selected] : [bookmark.id]
  }

  const openContext = (x: number, y: number, bookmark: Bookmark): void => {
    const store = s()
    const ids = contextIds(bookmark)
    const many = ids.length > 1
    const collections = flattenTree(buildTree(store.collections))
    const archiveIds = archivedCollectionIds(store.collections)
    const archived = bookmark.collectionId !== null && archiveIds.has(bookmark.collectionId)
    const moveMenu = (mx: number, my: number): void =>
      store.showContext(mx, my, [
        { label: 'Unsorted', icon: 'folder', onClick: () => void store.moveToCollection(ids, null) },
        ...collections.map<ContextItem>(({ collection, depth }) => ({
          label: `${'  '.repeat(depth)}${collection.name}`,
          icon: 'folder',
          color: collection.color ?? undefined,
          onClick: () => void store.moveToCollection(ids, collection.id)
        }))
      ])

    if (bookmark.deletedAt) {
      store.showContext(x, y, [
        { label: many ? `Restore ${ids.length} bookmarks` : 'Restore', icon: 'undo', onClick: () => void store.restoreIds(ids) },
        { label: 'Delete permanently…', icon: 'remove', danger: true, onClick: () => void store.purgeIds(ids) }
      ])
      return
    }
    store.showContext(x, y, [
      { label: 'Open in browser', icon: 'openLink', disabled: many, onClick: () => void store.openBookmark(bookmark) },
      { label: 'Copy link', icon: 'copy', disabled: many, onClick: () => void store.copyLink(bookmark) },
      { separator: true },
      { label: 'Edit…', icon: 'edit', disabled: many, onClick: () => store.setEditing(bookmark.id) },
      { label: 'Refresh details', icon: 'refresh', disabled: many, onClick: () => void store.refreshDetails(bookmark.id) },
      archived
        ? { label: many ? 'Bring ' + ids.length + ' back from the Archive' : 'Restore from Archive', icon: 'undo', onClick: () => void store.restoreBookmarks(ids) }
        : { label: many ? 'Send ' + ids.length + ' bookmarks to the Archive' : 'Send to Archive', icon: 'archive', onClick: () => void store.archiveBookmarks(ids) },
      { label: bookmark.favorite && !many ? 'Remove from favorites' : 'Add to favorites', icon: 'favorite', onClick: () => void store.toggleFavorite(ids) },
      { label: 'Move to…', icon: 'moveToFolder', onClick: () => setTimeout(() => moveMenu(x, y), 0) },
      { separator: true },
      { label: many ? `Move ${ids.length} bookmarks to Trash` : 'Move to Trash', icon: 'trash', danger: true, onClick: () => void store.trashIds(ids) }
    ])
  }

  return { contextIds, openContext }
}

/**
 * Where a bookmark is filed, as a trail of collections you can click: "Favorites › Menus › College". It saves
 * opening each bookmark to find out where it lives.
 */
function CollectionPath({ collectionId }: { collectionId: number | null }) {
  const collections = useStore((s) => s.collections)
  const store = useStore.getState
  const chain = useMemo(() => collectionChain(collections, collectionId), [collections, collectionId])
  const go = (e: React.MouseEvent, scope: Scope): void => {
    e.stopPropagation()
    store().setScope(scope)
  }

  if (chain.length === 0) {
    return (
      <div className="bm-path">
        <Icon name="folder" size={12} />
        <button className="dim" onClick={(e) => go(e, { kind: 'unsorted' })} title="Not in a collection">
          Unsorted
        </button>
      </div>
    )
  }
  return (
    <div className="bm-path" title={chain.map((c) => c.name).join(' › ')}>
      <Icon name={chain[0]?.role === 'archive' ? 'archive' : 'folder'} size={12} />
      {chain.map((c, index) => (
        <Fragment key={c.id}>
          {index > 0 && <span className="bm-path-sep" aria-hidden="true">›</span>}
          <button onClick={(e) => go(e, { kind: 'collection', id: c.id })} title={'Show ' + c.name}>
            {c.name}
          </button>
        </Fragment>
      ))}
    </div>
  )
}

const BookmarkRow = memo(function BookmarkRow({ bookmark, view, selected, editing, inTrash }: RowProps) {
  const { contextIds, openContext } = useRowActions()
  const store = useStore.getState

  const onClick = (e: React.MouseEvent): void => {
    const s = store()
    if (e.ctrlKey || e.metaKey) s.toggleSelect(bookmark.id)
    else if (e.shiftKey) s.selectRange(bookmark.id)
    else s.selectOnly(bookmark.id)
  }

  const onDragStart = (e: DragEvent): void => {
    e.dataTransfer.setData(BOOKMARK_DRAG_TYPE, JSON.stringify(contextIds(bookmark)))
    e.dataTransfer.setData('text/uri-list', bookmark.url)
    e.dataTransfer.effectAllowed = 'move'
    if (!store().selected.has(bookmark.id)) store().selectOnly(bookmark.id)
  }

  const tagChips = bookmark.tags.length > 0 && (
    <span className="row-tags">
      {bookmark.tags.map((tag) => (
        <button
          key={tag}
          className={bookmark.autoTags.includes(tag) ? 'tag-pill auto' : 'tag-pill'}
          onClick={(e) => {
            e.stopPropagation()
            store().setScope({ kind: 'tag', name: tag })
          }}
          title={`Show bookmarks tagged ${tag}`}
        >
          {tag}
        </button>
      ))}
    </span>
  )

  const broken = bookmark.status === 'broken' && (
    <span className="badge-broken" title={`Broken link${bookmark.httpStatus ? ` (HTTP ${bookmark.httpStatus})` : ''}`}>
      <Icon name="unlink" size={14} />
    </span>
  )

  const actions = (
    <span className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {inTrash ? (
        <button className="icon-btn" title="Restore" aria-label="Restore" onClick={() => void store().restoreIds([bookmark.id])}>
          <Icon name="undo" />
        </button>
      ) : (
        <>
          <button className={`icon-btn fav${bookmark.favorite ? ' on' : ''}`} title={bookmark.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label="Toggle favorite" aria-pressed={bookmark.favorite} onClick={() => void store().toggleFavorite([bookmark.id])}>
            <Icon name="favorite" />
          </button>
          <button className="icon-btn" title="Edit" aria-label="Edit bookmark" onClick={() => store().setEditing(bookmark.id)}>
            <Icon name="edit" />
          </button>
          <button className="icon-btn" title="Open in browser" aria-label="Open in browser" onClick={() => void store().openBookmark(bookmark)}>
            <Icon name="openLink" />
          </button>
        </>
      )}
      <button
        className="icon-btn"
        title="More"
        aria-label="More actions"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          openContext(r.left, r.bottom + 4, bookmark)
        }}
      >
        <Icon name="more" />
      </button>
    </span>
  )

  const className = `bm ${view}${selected ? ' selected' : ''}${editing ? ' editing' : ''}`
  const common = {
    className,
    draggable: true,
    onClick,
    onDoubleClick: () => !inTrash && void store().openBookmark(bookmark),
    onDragStart,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      if (!store().selected.has(bookmark.id)) store().selectOnly(bookmark.id)
      openContext(e.clientX, e.clientY, bookmark)
    },
    'data-id': bookmark.id,
    'aria-selected': selected,
    role: 'option'
  } as const

  if (view === 'grid') {
    return (
      <li {...common}>
        <Cover src={bookmark.coverUrl} />
        {actions}
        <div className="bm-body">
          <div className="bm-title-row">
            <Favicon src={bookmark.faviconUrl} />
            <span className="bm-title" title={bookmark.title}>{bookmark.title}</span>
            {bookmark.favorite && <Icon name="favorite" size={12} className="fav-mark" />}
            {broken}
          </div>
          {bookmark.excerpt && <p className="bm-excerpt">{bookmark.excerpt}</p>}
          <div className="bm-meta">
            <span className="bm-domain">{bookmark.domain}</span>
            <span>{formatDate(bookmark.createdAt)}</span>
          </div>
          {tagChips}
        </div>
      </li>
    )
  }

  if (view === 'headlines') {
    return (
      <li {...common}>
        <Favicon src={bookmark.faviconUrl} />
        <span className="bm-title" title={bookmark.title}>{bookmark.title}</span>
        {broken}
        {bookmark.favorite && <Icon name="favorite" size={12} className="fav-mark" />}
        <span className="bm-domain">{bookmark.domain}</span>
        <span className="bm-date">{formatDate(bookmark.createdAt)}</span>
        {actions}
      </li>
    )
  }

  return (
    <li {...common}>
      <Cover src={bookmark.coverUrl} />
      <div className="bm-body">
        <div className="bm-title-row">
          <span className="bm-title" title={bookmark.title}>{bookmark.title}</span>
          {bookmark.favorite && <Icon name="favorite" size={12} className="fav-mark" />}
          {broken}
        </div>
        <CollectionPath collectionId={bookmark.collectionId} />
        <div className="bm-meta">
          <Favicon src={bookmark.faviconUrl} size={14} />
          <span className="bm-domain">{bookmark.domain}</span>
          <span className="dot">·</span>
          <span>{formatDate(bookmark.createdAt)}</span>
          {tagChips}
        </div>
        {bookmark.excerpt && <p className="bm-excerpt">{bookmark.excerpt}</p>}
      </div>
      {actions}
    </li>
  )
})

export function BookmarkList(): React.JSX.Element {
  const items = useStore((s) => s.items)
  const total = useStore((s) => s.total)
  const loading = useStore((s) => s.loading)
  const ready = useStore((s) => s.ready)
  const view = useStore((s) => s.settings.view)
  const selected = useStore((s) => s.selected)
  const editingId = useStore((s) => s.editingId)
  const scope = useStore((s) => s.scope)
  const search = useStore((s) => s.search)
  const loadMore = useStore((s) => s.loadMore)
  const openAdd = useStore((s) => s.openAdd)
  const sentinel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadMore(), { root: scroller.current, rootMargin: '400px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMore, items.length])

  // Keep the keyboard-selected row in view.
  const anchor = useStore((s) => s.anchorId)
  useEffect(() => {
    if (anchor !== null) scroller.current?.querySelector(`[data-id="${anchor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [anchor])

  const inTrash = scope.kind === 'trash'

  let empty: React.ReactNode = null
  if (ready && !loading && items.length === 0) {
    empty = search ? (
      <div className="empty">
        <Icon name="search" size={32} />
        <h2>No matches</h2>
        <p>Nothing matches “{search}” here. Check the spelling or try fewer words.</p>
      </div>
    ) : inTrash ? (
      <div className="empty">
        <Icon name="trash" size={32} />
        <h2>Trash is empty</h2>
        <p>Deleted bookmarks stay here until you empty the Trash.</p>
      </div>
    ) : (
      <div className="empty">
        <Icon name="bookmark" size={32} />
        <h2>{scope.kind === 'all' ? 'Your library is empty' : 'Nothing here yet'}</h2>
        <p>
          {scope.kind === 'all'
            ? 'Add a link, paste a URL anywhere in the window, or import bookmarks from your browser.'
            : 'Drag bookmarks here, or add a new one.'}
        </p>
        <div className="empty-actions">
          <button className="btn primary" onClick={() => openAdd()}>
            <Icon name="add" /> Add bookmark
          </button>
          {scope.kind === 'all' && (
            <button className="btn" onClick={() => void useStore.getState().importFile()}>
              <Icon name="import" /> Import…
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="list-scroll" ref={scroller} onClick={(e) => e.target === e.currentTarget && useStore.getState().clearSelection()}>
      {empty}
      <ul className={`bm-list ${view}`} role="listbox" aria-multiselectable="true" aria-label="Bookmarks">
        {items.map((bookmark) => (
          <BookmarkRow key={bookmark.id} bookmark={bookmark} view={view} selected={selected.has(bookmark.id)} editing={editingId === bookmark.id} inTrash={inTrash} />
        ))}
      </ul>
      <div ref={sentinel} className="sentinel">
        {items.length < total && <span className="loading-more">Loading more…</span>}
      </div>
    </div>
  )
}
