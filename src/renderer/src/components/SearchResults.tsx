import { highlightParts } from '../lib/highlight'
import { formatRelativeTime } from '../lib/sessionView'
import { useStore } from '../store'

export default function SearchResults(): React.JSX.Element {
  const search = useStore((state) => state.search)
  const searching = useStore((state) => state.searching)
  const query = useStore((state) => state.query)
  const selectedKey = useStore((state) => state.selectedKey)
  const selectSession = useStore((state) => state.selectSession)
  const archived = useStore((state) => state.archived)
  const hits = search?.hits.filter((hit) => {
    const id = hit.sessionKey.split('/').pop() ?? ''
    return !archived.includes(id) && !archived.includes(hit.sessionKey)
  }) ?? []

  return (
    <section className="session-column">
      <div className="column-head">
        <span>搜索结果</span>
        <span className="muted">{hits.length}</span>
      </div>

      {searching && <div className="search-status">搜索中…</div>}
      {!searching && search && hits.length === 0 && (
        <div className="list-empty">没有匹配的会话</div>
      )}

      <div className="session-list">
        {hits.map((hit) => (
          <div
            key={`${hit.sessionKey}-${hit.matchUuid}`}
            className={`search-hit ${
              selectedKey === hit.sessionKey ? 'active' : ''
            }`}
            role="button"
            tabIndex={0}
            onClick={() =>
              selectSession(
                hit.sessionKey,
                hit.matchUuid || null,
                hit.matchPromptIndex ?? null
              )
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                selectSession(
                  hit.sessionKey,
                  hit.matchUuid || null,
                  hit.matchPromptIndex ?? null
                )
              }
            }}
          >
            <div className="search-hit-title">{hit.title}</div>
            <div className="search-hit-project">
              {hit.source === 'history' && (
                <span className="source-badge history">已清理</span>
              )}
              {hit.projectName} · {formatRelativeTime(hit.updatedAt)}
            </div>
            <div className="search-hit-snippet">
              {highlightParts(hit.snippet, query).map((part, index) =>
                part.match ? (
                  <mark key={index}>{part.text}</mark>
                ) : (
                  <span key={index}>{part.text}</span>
                )
              )}
            </div>
          </div>
        ))}
      </div>

      {search?.truncated && (
        <div className="search-status">结果过多，仅显示前 100 条</div>
      )}
    </section>
  )
}