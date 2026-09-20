import { useEffect, useState } from 'react'
import type { ProposalGroup, ProposalItem } from '@shared/types'
import { Icon } from '../icons'
import { useStore } from '../store'
import { errorMessage } from '../util'
import { Modal } from './ui'

const api = window.cairn
const plural = (n: number, word: string): string => n + ' ' + word + (n === 1 ? '' : 's')

/**
 * Suggested tags waiting for review, grouped by tag: "add 'docker' to 312 bookmarks" is one decision, not 312.
 * Expand a tag to see (and untick) individual bookmarks.
 */
export function ReviewDialog(): React.JSX.Element {
  const s = useStore()
  const [groups, setGroups] = useState<ProposalGroup[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [items, setItems] = useState<ProposalItem[]>([])
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => setGroups(await api.tagging.review.groups())
  useEffect(() => void load(), [])

  /** Runs one action, then refreshes the list and the rest of the app. */
  const act = async (work: () => Promise<string | void>): Promise<void> => {
    setBusy(true)
    try {
      const message = await work()
      setOpen(null)
      await load()
      await s.refreshAll()
      if (message) s.toast(message, 'success')
    } catch (error) {
      s.toast(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (tag: string): Promise<void> => {
    if (open === tag) return setOpen(null)
    setItems(await api.tagging.review.items(tag))
    setUnchecked(new Set())
    setOpen(tag)
  }

  const selected = (): number[] => items.filter((i) => !unchecked.has(i.bookmarkId)).map((i) => i.bookmarkId)
  const total = groups?.reduce((sum, g) => sum + g.count, 0) ?? 0

  return (
    <Modal
      title="Review suggested tags"
      onClose={() => s.closeDialog()}
      width={680}
      footer={
        <>
          <button
            className="btn"
            disabled={busy || total === 0}
            onClick={() =>
              void act(async () => {
                const yes = await s.confirm({
                  title: 'Discard all suggestions?',
                  message: 'They will not be suggested for those bookmarks again. Tags you have already added are not affected.',
                  confirmLabel: 'Discard all'
                })
                if (yes) await api.tagging.review.discardAll()
              })
            }
          >
            Discard all
          </button>
          <button className="btn primary" disabled={busy || total === 0} onClick={() => void act(async () => plural(await api.tagging.review.applyAll(), 'tag') + ' added. You can undo this in Tools.')}>
            Add all {total > 0 ? plural(total, 'suggestion') : 'suggestions'}
          </button>
        </>
      }
    >
      {groups === null ? (
        <p className="muted">Loading…</p>
      ) : groups.length === 0 ? (
        <div className="review-empty">
          <Icon name="ok" size={28} />
          <p>Nothing to review.</p>
          <p className="muted">Run Auto-tag from Tools, or fetch details for new bookmarks, and suggestions will appear here.</p>
        </div>
      ) : (
        <>
          <p className="muted review-intro">
            Each row is one tag suggested for several bookmarks. <strong>Add</strong> applies it to all of them, <strong>Skip</strong> declines it, and <strong>Never</strong> stops it being suggested again.
          </p>
          <ul className="review-list">
            {groups.map((g) => (
              <li key={g.tag} className="review-group">
                <div className="review-head">
                  <button className="review-toggle" onClick={() => void toggle(g.tag)} aria-expanded={open === g.tag} title="Show the bookmarks">
                    <span className={'twisty' + (open === g.tag ? ' open' : '')} />
                    <span className="review-tag">{g.tag}</span>
                    <span className={'review-badge' + (g.existing ? ' existing' : '')}>{g.existing ? 'in your library' : 'new tag'}</span>
                    <span className="muted">
                      {plural(g.count, 'bookmark')} · {Math.round(g.avgScore * 100)}%
                    </span>
                    {g.origins.includes('llm') && <Icon name="sparkles" size={12} />}
                  </button>
                  <span className="review-actions">
                    <button className="btn small primary" disabled={busy} onClick={() => void act(async () => plural(await api.tagging.review.apply(g.tag), 'bookmark') + ' tagged “' + g.tag + '”')}>
                      Add to all {g.count}
                    </button>
                    <button className="btn small" disabled={busy} onClick={() => void act(async () => void (await api.tagging.review.reject(g.tag)))}>
                      Skip
                    </button>
                    <button className="btn small danger-text" disabled={busy} title="Never suggest this tag again" onClick={() => void act(async () => void (await api.tagging.review.never(g.tag)))}>
                      Never
                    </button>
                  </span>
                </div>

                {open === g.tag && (
                  <div className="review-items">
                    <ul>
                      {items.map((item) => (
                        <li key={item.proposalId}>
                          <label>
                            <input
                              type="checkbox"
                              checked={!unchecked.has(item.bookmarkId)}
                              onChange={(e) =>
                                setUnchecked((current) => {
                                  const next = new Set(current)
                                  if (e.target.checked) next.delete(item.bookmarkId)
                                  else next.add(item.bookmarkId)
                                  return next
                                })
                              }
                            />
                            <span className="review-item-title" title={item.url}>
                              {item.title}
                            </span>
                            <span className="muted review-item-why">{item.reason}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div className="review-selection">
                      <button className="btn small primary" disabled={busy || selected().length === 0} onClick={() => void act(async () => plural(await api.tagging.review.apply(g.tag, selected()), 'bookmark') + ' tagged “' + g.tag + '”')}>
                        Add to {selected().length} selected
                      </button>
                      <button className="btn small" disabled={busy || selected().length === 0} onClick={() => void act(async () => void (await api.tagging.review.reject(g.tag, selected())))}>
                        Skip {selected().length} selected
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  )
}
