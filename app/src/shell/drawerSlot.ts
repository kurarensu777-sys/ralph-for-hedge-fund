import { createContext, useContext } from 'react'

/** the drawer's head bar as a portal target: a body that renders a DrawerHead (src/rooms/drawers)
 *  lifts it into the fixed head, beside the close button, instead of scrolling it with the body.
 *  null outside a drawer (the head then renders inline). */
export const DrawerSlot = createContext<HTMLElement | null>(null)
export const useDrawerSlot = () => useContext(DrawerSlot)
