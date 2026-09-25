import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, DEFAULT_TAGGING } from '../src/shared/types'
import { applySettingsPatch, readSettings } from '../src/main/settings'
import { makeRepo } from './helpers'

describe('settings', () => {
  it('starts with the defaults, including safe tagging defaults (suggest only, model off, this computer only)', () => {
    const settings = readSettings(makeRepo())
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(settings.tagging).toMatchObject({ mode: 'suggest', maxTags: 5 })
    expect(settings.tagging.llm).toMatchObject({ enabled: false, allowRemote: false, sendPageText: false, baseUrl: 'http://127.0.0.1:11434' })
  })

  it('saves simple settings and merges nested tagging settings field by field', () => {
    const repo = makeRepo()
    applySettingsPatch(repo, { theme: 'dark', view: 'grid' })
    applySettingsPatch(repo, { tagging: { mode: 'auto' } })
    applySettingsPatch(repo, { tagging: { llm: { enabled: true, model: 'qwen2.5:7b' } } })
    applySettingsPatch(repo, { tagging: { maxTags: 3 } })

    const settings = readSettings(repo)
    expect(settings).toMatchObject({ theme: 'dark', view: 'grid' })
    expect(settings.tagging).toMatchObject({ mode: 'auto', maxTags: 3 })
    expect(settings.tagging.llm).toMatchObject({ enabled: true, model: 'qwen2.5:7b', baseUrl: DEFAULT_TAGGING.llm.baseUrl, allowRemote: false })
  })

  it('rejects malformed custom rules with a readable message and keeps the previous ones', () => {
    const repo = makeRepo()
    applySettingsPatch(repo, { tagging: { userRules: '{"domains": {"example.net": ["mine"]}}' } })
    expect(() => applySettingsPatch(repo, { tagging: { userRules: '{nope' } })).toThrow(/Custom rules: Not valid JSON/)
    expect(() => applySettingsPatch(repo, { tagging: { userRules: '{"domains": {"a": "b"}}' } })).toThrow(/Custom rules/)
    expect(readSettings(repo).tagging.userRules).toContain('example.net')
  })

  it('will not save an Ollama address on another computer without explicit consent', () => {
    const repo = makeRepo()
    expect(() => applySettingsPatch(repo, { tagging: { llm: { baseUrl: 'http://192.168.1.20:11434' } } })).toThrow(/Ollama address: .*not on this computer/)
    expect(readSettings(repo).tagging.llm.baseUrl).toBe(DEFAULT_TAGGING.llm.baseUrl)

    applySettingsPatch(repo, { tagging: { llm: { baseUrl: 'http://192.168.1.20:11434', allowRemote: true } } })
    expect(readSettings(repo).tagging.llm).toMatchObject({ baseUrl: 'http://192.168.1.20:11434', allowRemote: true })

    // taking the consent back while a remote address is saved is refused too
    expect(() => applySettingsPatch(repo, { tagging: { llm: { allowRemote: false } } })).toThrow(/Ollama address/)
  })

  it('takes a colour scheme it knows and refuses one it does not', () => {
    const repo = makeRepo()
    expect(readSettings(repo).scheme).toBe('default')
    applySettingsPatch(repo, { scheme: 'ocean' })
    expect(readSettings(repo).scheme).toBe('ocean')
    expect(() => applySettingsPatch(repo, { scheme: 'chartreuse' })).toThrow()
    expect(readSettings(repo).scheme).toBe('ocean')
  })

  it('rejects out-of-range or unknown values', () => {
    const repo = makeRepo()
    expect(() => applySettingsPatch(repo, { tagging: { maxTags: 99 } })).toThrow()
    expect(() => applySettingsPatch(repo, { tagging: { llm: { baseUrl: 'ftp://127.0.0.1' } } })).toThrow(/Ollama address/)
    expect(readSettings(repo).tagging.maxTags).toBe(5)
  })

  it('remembers which sidebar lists are closed (they are stored as text, and come back as booleans)', () => {
    const repo = makeRepo()
    expect(readSettings(repo)).toMatchObject({ collectionsOpen: true, tagsOpen: true })

    applySettingsPatch(repo, { tagsOpen: false, sidebarWidth: 300 })
    expect(repo.getSettingRaw('tagsOpen')).toBe('false') // stored as text...
    expect(readSettings(repo)).toMatchObject({ tagsOpen: false, collectionsOpen: true, sidebarWidth: 300, theme: 'system' })

    applySettingsPatch(repo, { collectionsOpen: false })
    applySettingsPatch(repo, { tagsOpen: true })
    expect(readSettings(repo)).toMatchObject({ collectionsOpen: false, tagsOpen: true })
  })

  it('survives corrupt stored settings by falling back to the defaults', () => {
    const repo = makeRepo()
    repo.setSettingRaw('tagging', '{ this is not json')
    repo.setSettingRaw('theme', 'not-a-theme')
    expect(readSettings(repo)).toMatchObject({ theme: 'system', tagging: DEFAULT_TAGGING })
  })
})
