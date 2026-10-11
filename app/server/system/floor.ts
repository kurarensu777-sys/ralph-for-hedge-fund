import { STOP_FILE } from '../paths.ts'
import { logEvent } from '../db.ts'
import { publish } from '../events.ts'
import { stopHolds } from './stop.ts'

/** does floor/STOP hold now? An end-timed stop that has run out is cleared here and logged (server/system/stop.ts) */
export const floorStopped = (file = STOP_FILE, now = Date.now()) => stopHolds(file, now, until => {
  void logEvent('system', `floor/STOP ended on its own (end time ${new Date(until).toISOString()}): cleared`)
  publish('system'); publish('services')
})
