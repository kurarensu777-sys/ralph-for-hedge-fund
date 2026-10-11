// Types for guard-lib.mjs (plain ESM run by git hooks outside the build; the server imports it too).

export type SecretFinding = { path: string; line: number | null; why: string }
export type AddedLine = { n: number; text: string }

export function norm(p: string): string
export function covers(entry: string, path: string): boolean
export function outOfScope(writes: string[], paths: string[]): string[]
export function isExecution(path: string): boolean
export function isLegacyExecution(path: string): boolean
export function isBoardItem(path: string): boolean
export function secretFileReason(path: string): string | null
export function secretLineReason(line: string): string | null
export function addedLines(diff: string): Map<string, AddedLine[]>
export function secretFindings(paths: string[], added: Map<string, AddedLine[]>): SecretFinding[]
export function controlLineReason(text: string): string | null
export function isSnapshot(path: string): boolean
export function controlFindings(added: Map<string, AddedLine[]>): SecretFinding[]
export function chaptersWithoutReadWhen(pairs: { path: string; before: string | null; after: string | null }[]): { book: string; heading: string }[]
export type TopicFinding = { path: string; why: string }
export function verdict(a: { agentId: string | null; agent: { writes?: string[] } | null; fundPaths: string[]; secrets: SecretFinding[]; outsideFund: boolean; topics?: TopicFinding[]; controls?: SecretFinding[]; chapters?: { book: string; heading: string }[] }): { ok: boolean; errors: string[]; warnings: string[]; unstage: boolean }
export function shelfOfBook(path: string): { shelf: string; index: string } | null
export function shelfOfIndex(path: string): string | null
export function topicFindings(staged: { path: string; text: string | null }[], indexText: (indexPath: string) => string | null): TopicFinding[]
export function missingTrailers(message: string, env: Record<string, string | undefined>): [string, string][]

export function isLibraryBook(path: string): boolean
export const SHRINK_LIMIT: number
export function headings(text: string): string[]
export function sections(text: string): { heading: string; body: string[] }[]
export function headingSimilarity(a: string, b: string): number
export const RENAME_WORDS: number
export const RENAME_BODY: number
export type BookShrink = { linesPct: number; sectionsPct: number; lostHeadings: string[]; renamedHeadings: { from: string; to: string }[]; deleted: boolean; added: boolean; flagged: boolean }
export function bookShrink(beforeText: string | null | undefined, afterText: string | null | undefined): BookShrink
export function consolidationReason(message: string | null | undefined): string | null
export type ShrinkFile = { path: string; linesPct: number; sectionsPct: number; lostHeadings: string[]; renamedHeadings?: { from: string; to: string }[]; deleted: boolean }
export type ShrinkReport = { files: ShrinkFile[]; worst: number | null; ok: boolean; reason: string | null }
export function shrinkReport(pairs: { path: string; before: string | null; after: string | null }[], message: string | null | undefined): ShrinkReport
export function shrinkWarnings(report: ShrinkReport): string[]
export function parseNameStatusZ(out: string): { status: string; from: string; to: string }[]
