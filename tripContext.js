import fs from 'node:fs'

const path = process.env.TRIP_CONTEXT_PATH

export const TRIP_CONTEXT = path && fs.existsSync(path) ? fs.readFileSync(path, 'utf-8').trim() : null
