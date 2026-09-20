import { useMemo, useState, type DragEvent, type ReactNode } from 'react'
import type { Scope } from '@shared/types'
import { Icon, type IconName } from '../icons'
import { useStore, type ContextItem } from '../store'
import { BOOKMARK_DRAG_TYPE, COLLECTION_DRAG_TYPE, COLLECTION_COLORS, buildTree, descendantIds, sameScope, subtreeCounts, type TreeNode } from '../util'

function readBookmarkIds(event: DragEvent): number[] {
  try {
    const parsed: unknown = JSON.parse(event.dataTransfer.getData(BOOKMARK_DRAG_TYPE))
    return Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

interface NavItemProps {
  icon: IconName
  iconColor?: string
  label: string
  count?: number
  active: boolean
  depth?: number
  dim?: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onDropBookmarks?: (ids: number[]) => void
  leading?: ReactNode
  dropClass?: string
  dragProps?: React.HTMLAttributes<HTMLDivElement>
  title?: string
}

function NavItem({ icon, iconColor, label, count, active, depth = 0, dim, onClick, onContextMenu, onDropBookmarks, leading, dropClass, dragProps, title }: NavItemProps) {
  const [over, setOver] = useState(false)
  const accepts = (e: DragEvent): boolean => !!onDropBookmarks && e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE)
  return (
    <div
      role="button"
      tabIndex={0}
      className={`nav-item${active ? ' active' : ''}${over ? ' drop-over' : ''}${dropClass ? ` ${dropClass}` : ''}`}
      style={{ paddingLeft: 8 + depth * 16 }}
      title={title}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (accepts(e)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (!accepts(e)) return
        e.preventDefault()
        onDropBookmarks?.(readBookmarkIds(e))
      }}
      {...dragProps}
    >
      {leading ?? <span className="nav-spacer" />}
      <span className={dim ? 'nav-icon dim' : 'nav-icon'}>
        <Icon name={icon} color={iconColor} />
      </span>
      <span className="nav-label">{label}</span>
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </div>
  )
}

function CollectionNode({ node, depth, siblings, totals }: { node: TreeNode; depth: number; siblings: TreeNode[]; totals: Map<number, number> }) {
  const s = useStore()
  const { collection } = node
  const isExpanded = s.expanded[collection.id] ?? false
  const hasChildren = node.children.length > 0
  const [zone, setZone] = useState<'before' | 'inside' | 'after' | null>(null)
  const tree = useMemo(() => buildTree(s.collections), [s.collections])
  const scope: Scope = { kind: 'collection', id: collection.id }

  const menu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const items: ContextItem[] = [
      { label: 'New sub-collection…', icon: 'addFolder', onClick: () => void s.createCollection(collection.id) },
      { label: 'Rename…', icon: 'edit', onClick: () => void s.renameCollection(collection.id) },
      { separator: true },
      ...COLLECTION_COLORS.map<ContextItem>(({ name, value }) => ({
        label: name,
        color: value,
        checked: collection.color === value,
        onClick: () => void s.colorCollection(collection.id, value)
      })),
      { label: 'No color', checked: collection.color === null, onClick: () => void s.colorCollection(collection.id, null) },
      { separator: true },
      { label: 'Delete collection…', icon: 'deleteFolder', danger: true, onClick: () => void s.deleteCollection(collection.id) }
    ]
    s.showContext(e.clientX, e.clientY, items)
  }

  const zoneFor = (e: DragEvent): 'before' | 'inside' | 'after' => {
    const rect = e.currentTarget.getBoundingClientRect()
    const y = (e.clientY - rect.top) / rect.height
    return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside'
  }

  const dropProps: React.HTMLAttributes<HTMLDivElement> = {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(COLLECTION_DRAG_TYPE, String(collection.id))
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e) => {
      if (e.dataTransfer.types.includes(COLLECTION_DRAG_TYPE)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setZone(zoneFor(e))
      } else if (e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setZone('inside')
      }
    },
    onDragLeave: () => setZone(null),
    onDrop: (e) => {
      const where = zone
      setZone(null)
      if (e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE)) {
        e.preventDefault()
        void s.moveToCollection(readBookmarkIds(e), collection.id)
        return
      }
      const draggedId = Number(e.dataTransfer.getData(COLLECTION_DRAG_TYPE))
      if (!draggedId || draggedId === collection.id || !where) return
      e.preventDefault()
      e.stopPropagation()
      if (descendantIds(tree, draggedId).has(collection.id)) {
        s.toast('A collection cannot be moved into itself', 'error')
        return
      }
      if (where === 'inside') {
        const kids = node.children.filter((c) => c.collection.id !== draggedId).length
        void s.moveCollection(draggedId, collection.id, kids)
      } else {
        const others = siblings.filter((c) => c.collection.id !== draggedId)
        const at = others.findIndex((c) => c.collection.id === collection.id) + (where === 'after' ? 1 : 0)
        void s.moveCollection(draggedId, collection.parentId, at)
      }
    }
  }

  return (
    <>
      <NavItem
        icon={isExpanded && hasChildren ? 'folderOpen' : 'folder'}
        iconColor={collection.color ?? undefined}
        label={collection.name}
        count={totals.get(collection.id)}
        depth={depth}
        active={sameScope(s.scope, scope)}
        onClick={() => s.setScope(scope)}
        onContextMenu={menu}
        dragProps={dropProps}
        dropClass={zone ? `drop-${zone}` : undefined}
        leading={
          hasChildren ? (
            <button
              className={`twisty${isExpanded ? ' open' : ''}`}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              aria-expanded={isExpanded}
              onClick={(e) => (e.stopPropagation(), s.toggleExpanded(collection.id))}
            />
          ) : undefined
        }
      />
      {isExpanded && node.children.map((child) => <CollectionNode key={child.collection.id} node={child} depth={depth + 1} siblings={node.children} totals={totals} />)}
    </>
  )
}

export function Sidebar(): React.JSX.Element {
  const s = useStore()
  const [tagFilter, setTagFilter] = useState('')
  const tree = useMemo(() => buildTree(s.collections), [s.collections])
  const totals = useMemo(() => subtreeCounts(tree, s.counts.byCollection), [tree, s.counts.byCollection])
  const tags = useMemo(() => s.tags.filter((t) => t.name.toLowerCase().includes(tagFilter.trim().toLowerCase())), [s.tags, tagFilter])
  const [rootOver, setRootOver] = useState(false)

  const is = (scope: Scope): boolean => sameScope(s.scope, scope)

  return (
    <nav className="sidebar" aria-label="Library">
      <div className="nav-section">
        <NavItem icon="bookmark" label="All bookmarks" count={s.counts.all} active={is({ kind: 'all' })} onClick={() => s.setScope({ kind: 'all' })} />
        <NavItem
          icon="folder"
          dim
          label="Unsorted"
          count={s.counts.unsorted}
          active={is({ kind: 'unsorted' })}
          onClick={() => s.setScope({ kind: 'unsorted' })}
          onDropBookmarks={(ids) => void s.moveToCollection(ids, null)}
        />
        <NavItem icon="favorite" label="Favorites" count={s.counts.favorites} active={is({ kind: 'favorites' })} onClick={() => s.setScope({ kind: 'favorites' })} />
        {s.pendingProposals > 0 && (
          <NavItem icon="sparkles" label="Review suggested tags" count={s.pendingProposals} active={false} onClick={() => s.openDialog({ type: 'review-tags' })} />
        )}
        {(s.counts.broken > 0 || is({ kind: 'broken' })) && (
          <NavItem icon="unlink" label="Broken links" count={s.counts.broken} active={is({ kind: 'broken' })} onClick={() => s.setScope({ kind: 'broken' })} />
        )}
      </div>

      <div
        className={`nav-heading${rootOver ? ' drop-over' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(COLLECTION_DRAG_TYPE)) (e.preventDefault(), setRootOver(true))
        }}
        onDragLeave={() => setRootOver(false)}
        onDrop={(e) => {
          setRootOver(false)
          const id = Number(e.dataTransfer.getData(COLLECTION_DRAG_TYPE))
          if (id) (e.preventDefault(), void s.moveCollection(id, null, tree.filter((n) => n.collection.id !== id).length))
        }}
      >
        <span>Collections</span>
        <button className="icon-btn" onClick={() => void s.createCollection(null)} aria-label="New collection" title="New collection (Ctrl+Shift+N)">
          <Icon name="addFolder" />
        </button>
      </div>
      <div className="nav-section tree" role="tree">
        {tree.length === 0 && <p className="nav-empty">No collections yet. Create one to organize your bookmarks.</p>}
        {tree.map((node) => (
          <CollectionNode key={node.collection.id} node={node} depth={0} siblings={tree} totals={totals} />
        ))}
      </div>

      <div className="nav-heading">
        <span>Tags</span>
      </div>
      {s.tags.length > 8 && (
        <label className="tag-filter">
          <Icon name="filter" size={12} />
          <input value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} placeholder="Filter tags" aria-label="Filter tags" />
        </label>
      )}
      <div className="nav-section tags">
        {s.tags.length === 0 && <p className="nav-empty">Tags you add to bookmarks show up here.</p>}
        {tags.map((tag) => (
          <NavItem
            key={tag.name}
            icon="tag"
            label={tag.name}
            count={tag.count}
            active={is({ kind: 'tag', name: tag.name })}
            onClick={() => s.setScope({ kind: 'tag', name: tag.name })}
            onDropBookmarks={(ids) => void s.addTags(ids, [tag.name])}
            onContextMenu={(e) => {
              e.preventDefault()
              s.showContext(e.clientX, e.clientY, [
                { label: 'Rename tag…', icon: 'editTag', onClick: () => void s.renameTag(tag.name) },
                { label: 'Delete tag…', icon: 'deleteTag', danger: true, onClick: () => void s.deleteTag(tag.name) }
              ])
            }}
          />
        ))}
      </div>

      <div className="nav-spacer-grow" />
      <div className="nav-section bottom">
        <NavItem
          icon="trash"
          label="Trash"
          count={s.counts.trash}
          active={is({ kind: 'trash' })}
          onClick={() => s.setScope({ kind: 'trash' })}
          onDropBookmarks={(ids) => void s.trashIds(ids)}
        />
      </div>
      <div className="sidebar-footer">
        <button className="icon-btn" onClick={() => void s.importFile()} title="Import bookmarks (Ctrl+Shift+I)" aria-label="Import bookmarks">
          <Icon name="import" />
        </button>
        <button className="icon-btn" onClick={() => s.openDialog({ type: 'tools' })} title="Duplicates & broken links (Ctrl+Shift+T)" aria-label="Tools">
          <Icon name="duplicate" />
        </button>
        <button className="icon-btn" onClick={() => s.openDialog({ type: 'settings' })} title="Settings (Ctrl+,)" aria-label="Settings">
          <Icon name="settings" />
        </button>
      </div>
    </nav>
  )
}
