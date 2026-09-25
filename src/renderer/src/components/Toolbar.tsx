import { useMemo } from 'react'
import type { SortKey, ViewMode } from '@shared/types'
import { Icon, type IconName } from '../icons'
import { useStore, type ContextItem } from '../store'
import { archivedCollectionIds, buildTree, flattenTree } from '@shared/collections'

const VIEWS: { view: ViewMode; icon: IconName; label: string }[] = [
  { view: 'list', icon: 'list', label: 'List' },
  { view: 'grid', icon: 'grid', label: 'Grid' },
  { view: 'headlines', icon: 'headlines', label: 'Headlines' }
]

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'created', label: 'Date added' },
  { key: 'updated', label: 'Date updated' },
  { key: 'title', label: 'Title' },
  { key: 'domain', label: 'Website' }
]

export function useScopeTitle(): { title: string; icon: IconName } {
  const scope = useStore((s) => s.scope)
  const collections = useStore((s) => s.collections)
  switch (scope.kind) {
    case 'all':
      return { title: 'All bookmarks', icon: 'bookmark' }
    case 'unsorted':
      return { title: 'Unsorted', icon: 'folder' }
    case 'favorites':
      return { title: 'Favorites', icon: 'favorite' }
    case 'broken':
      return { title: 'Broken links', icon: 'unlink' }
    case 'trash':
      return { title: 'Trash', icon: 'trash' }
    case 'tag':
      return { title: `#${scope.name}`, icon: 'tag' }
    case 'collection':
      return { title: collections.find((c) => c.id === scope.id)?.name ?? 'Collection', icon: 'folder' }
  }
}

export function Toolbar({ searchRef }: { searchRef: React.RefObject<HTMLInputElement | null> }): React.JSX.Element {
  const s = useStore()
  const { title, icon } = useScopeTitle()
  const { sort, direction, view } = s.settings

  return (
    <header className="toolbar">
      <div className="toolbar-title">
        <Icon name={icon} size={18} />
        <h1>{title}</h1>
        <span className="toolbar-count">{s.total.toLocaleString()}</span>
      </div>

      <label className="search">
        <Icon name="search" />
        <input
          ref={searchRef}
          type="search"
          value={s.search}
          onChange={(e) => s.setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (s.search) s.setSearch('')
              else e.currentTarget.blur()
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              e.currentTarget.blur()
              s.moveSelection(1)
            }
          }}
          placeholder="Search…  try #tag  site:example.com  is:favorite"
          aria-label="Search bookmarks"
          spellCheck={false}
        />
      </label>

      <div className="toolbar-actions">
        {s.scope.kind === 'trash' && (
          <button className="btn" onClick={() => void s.emptyTrash()} disabled={s.counts.trash === 0}>
            <Icon name="trash" /> Empty Trash
          </button>
        )}

        <button
          className={'icon-btn' + (s.includeArchived ? ' on' : '')}
          aria-pressed={s.includeArchived}
          title={s.includeArchived ? 'Hide archived bookmarks' : 'Include archived bookmarks'}
          aria-label="Include archived bookmarks"
          onClick={() => s.setIncludeArchived(!s.includeArchived)}
        >
          <Icon name="archive" />
        </button>

        <div className="sort">
          <select value={sort} onChange={(e) => void s.updateSettings({ sort: e.target.value as SortKey })} aria-label="Sort by">
            {SORTS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            className="icon-btn"
            onClick={() => void s.updateSettings({ direction: direction === 'asc' ? 'desc' : 'asc' })}
            title={direction === 'asc' ? 'Ascending' : 'Descending'}
            aria-label={direction === 'asc' ? 'Sort ascending' : 'Sort descending'}
          >
            <Icon name={direction === 'asc' ? 'sortAsc' : 'sortDesc'} />
          </button>
        </div>

        <div className="segmented" role="group" aria-label="Layout">
          {VIEWS.map((v) => (
            <button
              key={v.view}
              className={view === v.view ? 'active' : ''}
              onClick={() => void s.updateSettings({ view: v.view })}
              title={`${v.label} layout`}
              aria-label={`${v.label} layout`}
              aria-pressed={view === v.view}
            >
              <Icon name={v.icon} />
            </button>
          ))}
        </div>

        <button className="btn primary" onClick={() => s.openAdd()} title="New bookmark (Ctrl+N)">
          <Icon name="add" /> Add
        </button>
      </div>
    </header>
  )
}

export function BulkBar(): React.JSX.Element | null {
  const s = useStore()
  const ids = useMemo(() => [...s.selected], [s.selected])
  const options = useMemo(() => flattenTree(buildTree(s.collections)), [s.collections])
  if (ids.length < 2) return null
  const inTrash = s.scope.kind === 'trash'
  // Looking inside the Archive, the action is to bring things back out.
  const archived = s.scope.kind === 'collection' && archivedCollectionIds(s.collections).has(s.scope.id)

  const openMoveMenu = (e: React.MouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const items: ContextItem[] = [
      { label: 'Unsorted', icon: 'folder', onClick: () => void s.moveToCollection(ids, null) },
      ...options.map<ContextItem>(({ collection, depth }) => ({
        label: `${'  '.repeat(depth)}${collection.name}`,
        icon: 'folder',
        color: collection.color ?? undefined,
        onClick: () => void s.moveToCollection(ids, collection.id)
      }))
    ]
    s.showContext(rect.left, rect.bottom + 4, items)
  }

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Selection actions">
      <strong>{ids.length} selected</strong>
      {inTrash ? (
        <>
          <button className="btn" onClick={() => void s.restoreIds(ids)}>
            <Icon name="undo" /> Restore
          </button>
          <button className="btn danger-text" onClick={() => void s.purgeIds(ids)}>
            <Icon name="remove" /> Delete permanently
          </button>
        </>
      ) : (
        <>
          <button className="btn" onClick={openMoveMenu}>
            <Icon name="moveToFolder" /> Move to…
          </button>
          <button
            className="btn"
            onClick={async () => {
              const text = await s.prompt({ title: 'Add tags', label: 'Tags (comma separated)', confirmLabel: 'Add tags', placeholder: 'reading, recipes' })
              if (text) await s.addTags(ids, text.split(',').map((t) => t.trim()).filter(Boolean))
            }}
          >
            <Icon name="tag" /> Tag…
          </button>
          <button className="btn" onClick={() => void s.toggleFavorite(ids)}>
            <Icon name="favorite" /> Favorite
          </button>
          <button className="btn" onClick={() => void (archived ? s.restoreBookmarks(ids) : s.archiveBookmarks(ids))} title={archived ? 'Put them back where they came from' : 'Keep them, out of searches and exports'}>
            <Icon name="archive" /> {archived ? 'Restore' : 'Archive'}
          </button>
          <button className="btn danger-text" onClick={() => void s.trashIds(ids)}>
            <Icon name="trash" /> Trash
          </button>
        </>
      )}
      <span className="spacer" />
      <button className="btn" onClick={s.clearSelection}>
        Clear
      </button>
    </div>
  )
}
