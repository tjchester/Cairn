import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import { useStore } from '../store'
import { buildTree, flattenTree } from '../util'

// ------------------------------------------------------------------ Modal

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}

export function Modal({ title, onClose, children, footer, width = 460 }: ModalProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    // Autofocus the first field unless a child already took focus.
    if (ref.current && !ref.current.contains(document.activeElement)) {
      ref.current.querySelector<HTMLElement>('input, textarea, select, button.primary')?.focus()
    }
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }} ref={ref}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------- Confirm / prompt

function ConfirmDialog({ title, message, confirmLabel, danger }: { title: string; message: string; confirmLabel: string; danger?: boolean }) {
  const close = useStore((s) => s.closeDialog)
  return (
    <Modal
      title={title}
      onClose={() => close(false)}
      width={420}
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button className={`btn primary${danger ? ' danger' : ''}`} onClick={() => close(true)} autoFocus>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="dialog-message">{message}</p>
    </Modal>
  )
}

function PromptDialog({ title, label, initial, confirmLabel, placeholder }: { title: string; label: string; initial: string; confirmLabel: string; placeholder?: string }) {
  const close = useStore((s) => s.closeDialog)
  const [value, setValue] = useState(initial)
  return (
    <Modal title={title} onClose={() => close(null)} width={400}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) close(value.trim())
        }}
      >
        <label className="field">
          <span>{label}</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} maxLength={100} autoFocus onFocus={(e) => e.target.select()} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export { ConfirmDialog, PromptDialog }

// ------------------------------------------------------------ Context menu

export function ContextMenu(): React.JSX.Element | null {
  const context = useStore((s) => s.context)
  const hide = useStore((s) => s.hideContext)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!context || !ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(context.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(context.y, window.innerHeight - height - 4))
    })
    ref.current.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }, [context])

  useEffect(() => {
    if (!context) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) hide()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = e.key === 'ArrowDown' ? at + 1 : at - 1
        buttons[(next + buttons.length) % buttons.length]?.focus()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
    }
  }, [context, hide])

  if (!context) return null
  return (
    <div className="context-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {context.items.map((item, index) =>
        item.separator ? (
          <div className="context-sep" key={index} role="separator" />
        ) : (
          <button
            key={index}
            role="menuitem"
            className={`context-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              hide()
              item.onClick?.()
            }}
          >
            <span className="context-icon">
              {item.icon ? <Icon name={item.icon} color={item.color} /> : item.color ? <span className="swatch" style={{ background: item.color }} /> : null}
            </span>
            <span className="context-label">{item.label}</span>
            {item.checked && <Icon name="check" />}
          </button>
        )
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Toasts

export function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={toast.kind === 'error' ? 'error' : toast.kind === 'success' ? 'ok' : 'info'} />
          <span className="toast-text">{toast.message}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                toast.action?.onClick()
                dismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button className="icon-btn" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------- Form controls

export function CollectionSelect({
  value,
  onChange,
  exclude
}: {
  value: number | null
  onChange: (id: number | null) => void
  exclude?: Set<number>
}): React.JSX.Element {
  const collections = useStore((s) => s.collections)
  const options = useMemo(() => flattenTree(buildTree(collections)).filter((o) => !exclude?.has(o.collection.id)), [collections, exclude])
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
      <option value="">Unsorted</option>
      {options.map(({ collection, depth }) => (
        <option key={collection.id} value={collection.id}>
          {'   '.repeat(depth)}
          {collection.name}
        </option>
      ))}
    </select>
  )
}

export function TagInput({ value, onChange, placeholder = 'Add tags…' }: { value: string[]; onChange: (tags: string[]) => void; placeholder?: string }): React.JSX.Element {
  const known = useStore((s) => s.tags)
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [highlight, setHighlight] = useState(-1)

  const suggestions = useMemo(() => {
    const taken = new Set(value.map((t) => t.toLowerCase()))
    const needle = draft.trim().toLowerCase().replace(/^#/, '')
    return known
      .filter((t) => !taken.has(t.name.toLowerCase()) && (needle === '' || t.name.toLowerCase().includes(needle)))
      .slice(0, 6)
  }, [known, value, draft])

  const add = (raw: string): void => {
    const tag = raw.trim().replace(/^#+/, '')
    if (!tag) return
    if (!value.some((t) => t.toLowerCase() === tag.toLowerCase())) onChange([...value, tag])
    setDraft('')
    setHighlight(-1)
  }

  return (
    <div className={`tag-input${focused ? ' focused' : ''}`} onClick={(e) => e.currentTarget.querySelector('input')?.focus()}>
      {value.map((tag) => (
        <span className="chip" key={tag}>
          {tag}
          <button type="button" className="chip-x" aria-label={`Remove tag ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))}>
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={value.length === 0 ? placeholder : ''}
        onChange={(e) => {
          const text = e.target.value
          if (text.endsWith(',')) add(text.slice(0, -1))
          else setDraft(text)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          add(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            const picked = highlight >= 0 ? suggestions[highlight]?.name : undefined
            add(picked ?? draft)
          } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            onChange(value.slice(0, -1))
          } else if (e.key === 'ArrowDown' && suggestions.length) {
            e.preventDefault()
            setHighlight((h) => (h + 1) % suggestions.length)
          } else if (e.key === 'ArrowUp' && suggestions.length) {
            e.preventDefault()
            setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1))
          }
        }}
        aria-label="Tags"
      />
      {focused && suggestions.length > 0 && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((s, i) => (
            <li key={s.name} role="option" aria-selected={i === highlight} className={i === highlight ? 'active' : ''} onMouseDown={(e) => (e.preventDefault(), add(s.name))}>
              <Icon name="tag" size={12} /> {s.name}
              <span className="count">{s.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Favicon({ src, size = 16 }: { src: string | null; size?: number }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  if (!src || failed) return <Icon name="web" size={size} className="favicon-fallback" />
  return <img className="favicon" src={src} width={size} height={size} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

export function Cover({ src }: { src: string | null }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  if (!src || failed) {
    return (
      <div className="cover placeholder">
        <Icon name="image" size={24} />
      </div>
    )
  }
  return (
    <div className="cover">
      <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    </div>
  )
}
