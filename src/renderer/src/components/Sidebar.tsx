import { useMemo, useState, type DragEvent, type ReactNode } from 'react'
import type { Scope } from '@shared/types'
import { Icon, type IconName } from '../icons'
import { useStore, type ContextItem } from '../store'
import { buildTree, descendantIds, subtreeCounts, type TreeNode } from '@shared/collections'
import { BOOKMARK_DRAG_TYPE, COLLECTION_DRAG_TYPE, COLLECTION_COLORS, sameScope } from '../util'

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

function CollectionNode({ node, depth, totals, inArchive = false }: { node: TreeNode; depth: number; totals: Map<number, number>; inArchive?: boolean }) {
  const s = useStore()
  const { collection } = node
  const isExpanded = s.expanded[collection.id] ?? false
  const hasChildren = node.children.length > 0
  const [over, setOver] = useState(false)
  const tree = useMemo(() => buildTree(s.collections), [s.collections])
  const scope: Scope = { kind: 'collection', id: collection.id }
  const isArchive = collection.role === 'archive'

  const menu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const items: ContextItem[] = [
      { label: 'New sub-collection…', icon: 'addFolder', onClick: () => void s.createCollection(collection.id) },
      { label: 'Rename…', icon: 'edit', onClick: () => void s.renameCollection(collection.id) },
      ...(collection.role === 'archive'
        ? []
        : [
            inArchive
              ? { label: 'Restore from Archive', icon: 'undo' as const, onClick: () => void s.restoreCollection(collection.id) }
              : { label: 'Send to Archive…', icon: 'archive' as const, onClick: () => void s.archiveCollection(collection.id) }
          ]),
      { separator: true },
      ...COLLECTION_COLORS.map<ContextItem>(({ name, value }) => ({
        label: name,
        color: value,
        checked: collection.color === value,
        onClick: () => void s.colorCollection(collection.id, value)
      })),
      { label: 'No color', checked: collection.color === null, onClick: () => void s.colorCollection(collection.id, null) },
      { separator: true },
      ...(collection.role === 'archive'
        ? []
        : [{ label: 'Delete collection…', icon: 'deleteFolder' as const, danger: true, onClick: () => void s.deleteCollection(collection.id) }])
    ]
    s.showContext(e.clientX, e.clientY, items)
  }

  // Dropping a collection here puts it inside this one; the Collections heading takes it back to the top level.
  // (The list is sorted A-Z, so there is nothing to reorder by hand.)
  const dropProps: React.HTMLAttributes<HTMLDivElement> = {
    draggable: !isArchive, // the Archive stays at the top level
    onDragStart: (e) => {
      e.dataTransfer.setData(COLLECTION_DRAG_TYPE, String(collection.id))
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(COLLECTION_DRAG_TYPE) && !e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (e) => {
      setOver(false)
      if (e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE)) {
        e.preventDefault()
        // Dropped on the Archive itself: file them under the folders they came from. Dropped on a folder inside it:
        // put them exactly there.
        if (isArchive) void s.archiveBookmarks(readBookmarkIds(e))
        else void s.moveToCollection(readBookmarkIds(e), collection.id)
        return
      }
      const draggedId = Number(e.dataTransfer.getData(COLLECTION_DRAG_TYPE))
      if (!draggedId || draggedId === collection.id) return
      e.preventDefault()
      e.stopPropagation()
      if (descendantIds(tree, draggedId).has(collection.id)) {
        s.toast('A collection cannot be moved into itself', 'error')
        return
      }
      void s.moveCollection(draggedId, collection.id, node.children.length)
    }
  }

  return (
    <>
      <NavItem
        icon={isArchive ? 'archive' : isExpanded && hasChildren ? 'folderOpen' : 'folder'}
        iconColor={collection.color ?? undefined}
        label={collection.name}
        count={totals.get(collection.id)}
        depth={depth}
        active={sameScope(s.scope, scope)}
        onClick={() => s.setScope(scope)}
        onContextMenu={menu}
        dragProps={dropProps}
        dropClass={over ? 'drop-inside' : undefined}
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
      {isExpanded && node.children.map((child) => <CollectionNode key={child.collection.id} node={child} depth={depth + 1} totals={totals} inArchive={inArchive || collection.role === 'archive'} />)}
    </>
  )
}

/**
 * The arrow on a sidebar heading that opens and closes that one list (Collections, Tags). Nothing to do with
 * hiding the whole sidebar; a closed list shows how many it is hiding.
 */
function SectionToggle({ id, label, open, count, onToggle }: { id: string; label: string; open: boolean; count: number; onToggle: () => void }) {
  return (
    <button className="nav-heading-toggle" aria-expanded={open} aria-controls={id} title={(open ? 'Hide ' : 'Show ') + label.toLowerCase()} onClick={onToggle}>
      <span className={`twisty${open ? ' open' : ''}`} aria-hidden="true" />
      <span>{label}</span>
      {!open && count > 0 && <span className="nav-heading-count">{count}</span>}
    </button>
  )
}

export function Sidebar(): React.JSX.Element {
  const s = useStore()
  const [tagFilter, setTagFilter] = useState('')
  const wholeTree = useMemo(() => buildTree(s.collections), [s.collections])
  const totals = useMemo(() => subtreeCounts(wholeTree, s.counts.byCollection), [wholeTree, s.counts.byCollection])
  const archiveNode = useMemo(() => wholeTree.find((n) => n.collection.role === 'archive') ?? null, [wholeTree])
  const tree = useMemo(() => wholeTree.filter((n) => n.collection.role !== 'archive'), [wholeTree])
  const tags = useMemo(() => s.tags.filter((t) => t.name.toLowerCase().includes(tagFilter.trim().toLowerCase())), [s.tags, tagFilter])
  const [rootOver, setRootOver] = useState(false)
  const { collectionsOpen, tagsOpen } = s.settings

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
          if (!e.dataTransfer.types.includes(COLLECTION_DRAG_TYPE)) return
          e.preventDefault()
          setRootOver(true)
          if (!collectionsOpen) void s.updateSettings({ collectionsOpen: true }) // so you can see where it lands
        }}
        onDragLeave={() => setRootOver(false)}
        onDrop={(e) => {
          setRootOver(false)
          const id = Number(e.dataTransfer.getData(COLLECTION_DRAG_TYPE))
          if (id) (e.preventDefault(), void s.moveCollection(id, null, tree.filter((n) => n.collection.id !== id).length))
        }}
      >
        <SectionToggle id="nav-collections" label="Collections" open={collectionsOpen} count={s.collections.length} onToggle={() => void s.updateSettings({ collectionsOpen: !collectionsOpen })} />
        <button
          className="icon-btn"
          onClick={() => {
            if (!collectionsOpen) void s.updateSettings({ collectionsOpen: true })
            void s.createCollection(null)
          }}
          aria-label="New collection"
          title="New collection (Ctrl+Shift+N)"
        >
          <Icon name="addFolder" />
        </button>
      </div>
      {/* Closed lists stay in the page (empty) so the heading's arrow keeps something to point at. */}
      <div className="nav-section tree" id="nav-collections" role="tree" hidden={!collectionsOpen}>
        {collectionsOpen && tree.length === 0 && <p className="nav-empty">No collections yet. Create one to organize your bookmarks.</p>}
        {collectionsOpen && tree.map((node) => <CollectionNode key={node.collection.id} node={node} depth={0} totals={totals} />)}
      </div>

      <div className="nav-heading">
        <SectionToggle id="nav-tags" label="Tags" open={tagsOpen} count={s.tags.length} onToggle={() => void s.updateSettings({ tagsOpen: !tagsOpen })} />
      </div>
      {tagsOpen && s.tags.length > 8 && (
        <label className="tag-filter">
          <Icon name="filter" size={12} />
          <input value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} placeholder="Filter tags" aria-label="Filter tags" />
        </label>
      )}
      <div className="nav-section tags" id="nav-tags" hidden={!tagsOpen}>
        {tagsOpen && s.tags.length === 0 && <p className="nav-empty">Tags you add to bookmarks show up here.</p>}
        {(tagsOpen ? tags : []).map((tag) => (
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
        {archiveNode && <CollectionNode key={archiveNode.collection.id} node={archiveNode} depth={0} totals={totals} />}
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
