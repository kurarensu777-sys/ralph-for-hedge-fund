import { CATEGORIES, catVar, type Category } from '../../ui/categories.ts'

/** a repo's category: the five repos are the five non-dashboard categories (fund gold, app violet,
 *  platform teal, research green, execution grey); anything else is neutral, never a borrowed colour.
 *  The neutral is --faint, not --off: it colours a repo NAME as text, and --off (a status-dot grey) is
 *  too dark to read as text on the panel */
export const repoCat = (r: string): Category => (CATEGORIES as Record<string, Category>)[r] ?? { ...CATEGORIES.execution, color: 'var(--faint)' }

/** the inline style that hands a repo's colour to CSS as `--c` */
export const repoVar = (r: string) => catVar(repoCat(r))
