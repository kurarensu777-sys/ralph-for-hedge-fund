/** the blocked marker: a small padlock, the open blockers in its title */
export function Lock({ ids }: { ids: string[] }) {
  return (
    <svg className="board-lock" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-label="blocked">
      <title>{`blocked by ${ids.join(', ')}`}</title>
      <rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}
