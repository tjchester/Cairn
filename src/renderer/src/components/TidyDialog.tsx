import { useEffect, useMemo, useState } from 'react'
import type { TidyPlan } from '@shared/types'
import { Icon } from '../icons'
import { useStore } from '../store'
import { errorMessage } from '../util'
import { Modal } from './ui'

const api = window.cairn
const plural = (n: number, word: string): string => n.toLocaleString('en-US') + ' ' + word + (n === 1 ? '' : 's')
const RARE_CHOICES = [1, 2, 3, 5]
const MAX_SHOWN = 120

interface GroupChoice {
  on: boolean
  keep: string
}

/**
 * Cleans up the tag list: merges look-alike tags ("ad-blocker", "ad-blockers", "ad-blocking"), and removes automatic tags
 * that almost nothing shares. Nothing changes until "Tidy" is pressed, tags you added yourself are never removed, and
 * the whole thing can be undone.
 */
export function TidyDialog(): React.JSX.Element {
  const s = useStore()
  const [rareMax, setRareMax] = useState(2)
  const [plan, setPlan] = useState<TidyPlan | null>(null)
  const [choices, setChoices] = useState<Map<string, GroupChoice>>(new Map())
  const [removeRare, setRemoveRare] = useState(true)
  const [keepOnlyTag, setKeepOnlyTag] = useState(true)
  const [vagueOn, setVagueOn] = useState<Set<string>>(new Set())
  const [showRare, setShowRare] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    void api.tagging.tidy.plan(rareMax).then((next) => {
      if (!current) return
      setPlan(next)
      setChoices((previous) => {
        const merged = new Map<string, GroupChoice>()
        for (const g of next.groups) merged.set(g.id, previous.get(g.id) ?? { on: g.selected, keep: g.keep })
        return merged
      })
    })
    return () => {
      current = false
    }
  }, [rareMax])

  const chosen = useMemo(() => (plan ? plan.groups.filter((g) => choices.get(g.id)?.on) : []), [plan, choices])
  const folded = chosen.reduce((n, g) => n + g.members.length - 1, 0)
  const rareCount = plan && removeRare ? plan.rare.tags.length : 0
  const vagueCount = plan ? plan.vague.filter((t) => vagueOn.has(t.name)).length : 0
  const nothing = folded + rareCount + vagueCount === 0

  const setChoice = (id: string, patch: Partial<GroupChoice>): void =>
    setChoices((previous) => {
      const next = new Map(previous)
      const current = next.get(id)
      if (current) next.set(id, { ...current, ...patch })
      return next
    })
  const setAll = (on: boolean): void =>
    setChoices((previous) => {
      const next = new Map<string, GroupChoice>()
      for (const [id, choice] of previous) next.set(id, { ...choice, on })
      return next
    })

  const apply = async (): Promise<void> => {
    if (!plan) return
    setBusy(true)
    try {
      const result = await api.tagging.tidy.apply({
        merges: chosen.map((g) => {
          const keep = choices.get(g.id)?.keep ?? g.keep
          return { keep, from: g.members.map((m) => m.name).filter((name) => name !== keep) }
        }),
        remove: [...(removeRare ? plan.rare.tags.map((t) => t.name) : []), ...plan.vague.filter((t) => vagueOn.has(t.name)).map((t) => t.name)],
        rareMaxUses: rareMax,
        keepOnlyTag
      })
      s.closeDialog()
      await s.refreshAll()
      const parts = [result.merged > 0 ? plural(result.merged, 'tag') + ' merged' : '', result.removed > 0 ? plural(result.removed, 'tag use') + ' removed' : ''].filter(Boolean)
      if (result.id === null) s.toast('Nothing needed changing.', 'info')
      else s.toast('Tidied: ' + parts.join(', ') + '.', 'success', { label: 'Undo', onClick: () => void s.undoTidy(result.id as number) })
    } catch (error) {
      s.toast(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Tidy tags"
      onClose={() => s.closeDialog()}
      width={720}
      footer={
        <>
          <span className="muted tidy-summary" role="status">
            {plan === null ? 'Looking at your tags…' : nothing ? 'Nothing selected.' : 'Will merge ' + plural(folded, 'tag') + ' and remove ' + plural(rareCount + vagueCount, 'tag') + ' (you can undo this).'}
          </span>
          <button className="btn" onClick={() => s.closeDialog()}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || nothing} onClick={() => void apply()}>
            Tidy
          </button>
        </>
      }
    >
      {plan === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="muted tidy-intro">
            You have {plural(plan.totalTags, 'tag')}; {plan.oneUse.toLocaleString('en-US')} of them are used by only one bookmark. Nothing changes until you press <strong>Tidy</strong>. Tags you added yourself are
            never removed.
          </p>

          <section className="tidy-section">
            <div className="tidy-heading">
              <h4>
                <Icon name="tag" size={14} /> Merge look-alike tags <span className="muted">({plan.groups.length})</span>
              </h4>
              {plan.groups.length > 0 && (
                <span className="tidy-bulk">
                  <button className="btn small" onClick={() => setAll(true)}>
                    Select all
                  </button>
                  <button className="btn small" onClick={() => setAll(false)}>
                    Select none
                  </button>
                </span>
              )}
            </div>
            {plan.groups.length === 0 ? (
              <p className="muted">No look-alike tags found.</p>
            ) : (
              <>
                <p className="muted tidy-note">Choose the tag to keep in each group; the others become that tag on every bookmark. Looser matches (“similar”) come first, so glance over those; groups that would merge two of your own tags start unticked.</p>
                <ul className="tidy-groups">
                  {plan.groups.map((g) => {
                    const choice = choices.get(g.id) ?? { on: g.selected, keep: g.keep }
                    return (
                      <li key={g.id} className={'tidy-group' + (choice.on ? '' : ' off')}>
                        <label className="tidy-toggle">
                          <input type="checkbox" checked={choice.on} onChange={(e) => setChoice(g.id, { on: e.target.checked })} aria-label={'Merge ' + g.members.map((m) => m.name).join(', ')} />
                        </label>
                        <div className="tidy-members">
                          {g.members.map((m) => (
                            <label key={m.name} className={'tidy-member' + (choice.keep === m.name ? ' keep' : '')} title={choice.keep === m.name ? 'The tag that is kept' : 'Keep this one instead'}>
                              <input type="radio" name={'keep-' + g.id} checked={choice.keep === m.name} onChange={() => setChoice(g.id, { keep: m.name })} />
                              <span className="tidy-name">{m.name}</span>
                              <span className="muted">{m.uses.toLocaleString('en-US')}</span>
                              {m.yours && <span className="review-badge existing">yours</span>}
                            </label>
                          ))}
                        </div>
                        <span className="review-badge">{g.spellingOnly ? 'same word' : 'similar'}</span>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </section>

          <section className="tidy-section">
            <div className="tidy-heading">
              <h4>
                <Icon name="deleteTag" size={14} /> Remove rare automatic tags
              </h4>
            </div>
            <label className="check">
              <input type="checkbox" checked={removeRare} onChange={(e) => setRemoveRare(e.target.checked)} />
              <span>
                Remove automatic tags used by{' '}
                <select value={rareMax} onChange={(e) => setRareMax(Number(e.target.value))} aria-label="Rare means used by at most">
                  {RARE_CHOICES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>{' '}
                {rareMax === 1 ? 'bookmark' : 'bookmarks'} or fewer
              </span>
            </label>
            <p className="muted tidy-note" data-testid="tidy-rare-summary">
              {plural(plan.rare.tags.length, 'tag')}, {plural(plan.rare.uses, 'use')} in all.{' '}
              {plan.rare.tags.length > 0 && (
                <button className="link-btn" onClick={() => setShowRare((v) => !v)}>
                  {showRare ? 'Hide the list' : 'Show the list'}
                </button>
              )}
            </p>
            {showRare && (
              <p className="tidy-chips">
                {plan.rare.tags.slice(0, MAX_SHOWN).map((t) => (
                  <span key={t.name} className="tidy-chip">
                    {t.name}
                  </span>
                ))}
                {plan.rare.tags.length > MAX_SHOWN && <span className="muted"> and {plan.rare.tags.length - MAX_SHOWN} more</span>}
              </p>
            )}
            <label className="check">
              <input type="checkbox" checked={keepOnlyTag} onChange={(e) => setKeepOnlyTag(e.target.checked)} />
              <span>
                Keep a rare tag when it is the only tag a bookmark has{plan.rare.onlyTag > 0 ? ' (' + plural(plan.rare.onlyTag, 'bookmark') + ')' : ''}
              </span>
            </label>
          </section>

          {plan.vague.length > 0 && (
            <section className="tidy-section">
              <div className="tidy-heading">
                <h4>
                  <Icon name="warning" size={14} /> Vague automatic tags <span className="muted">({plan.vague.length})</span>
                </h4>
              </div>
              <p className="muted tidy-note">Words that say little on their own. Tick the ones to remove.</p>
              <p className="tidy-chips">
                {plan.vague.map((t) => (
                  <label key={t.name} className={'tidy-chip pick' + (vagueOn.has(t.name) ? ' on' : '')}>
                    <input
                      type="checkbox"
                      checked={vagueOn.has(t.name)}
                      onChange={(e) =>
                        setVagueOn((previous) => {
                          const next = new Set(previous)
                          if (e.target.checked) next.add(t.name)
                          else next.delete(t.name)
                          return next
                        })
                      }
                    />
                    {t.name} <span className="muted">{t.uses}</span>
                  </label>
                ))}
              </p>
            </section>
          )}
        </>
      )}
    </Modal>
  )
}
