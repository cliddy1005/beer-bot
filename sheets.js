import { google } from 'googleapis'
import Anthropic from '@anthropic-ai/sdk'

const SHEET_ID = process.env.GOOGLE_SHEET_ID
const SHEET_NAME = 'Bets'
const RANGE_ALL = `${SHEET_NAME}!A:I`

// Columns: A id | B bettor | C opponent | D condition | E stake
//          F status | G createdAt | H winner | I resolvedAt

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  })
  return google.sheets({ version: 'v4', auth })
}

export async function addBet(bet) {
  const sheets = await getSheetsClient()
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: RANGE_ALL,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        [bet.id, bet.bettor, bet.opponent, bet.condition, bet.stake, bet.status, new Date().toISOString()]
      ]
    }
  })
}

async function getAllRows() {
  const sheets = await getSheetsClient()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE_ALL })
  return res.data.values || []
}

export async function getOpenBets() {
  const rows = await getAllRows()
  return rows
    .slice(1)
    .filter((r) => r[5] === 'open')
    .map((r) => ({ id: r[0], bettor: r[1], opponent: r[2], condition: r[3], stake: r[4] }))
}

export async function resolveBet(text, senderName) {
  const openBets = await getOpenBets()
  if (openBets.length === 0) return 'No open bets to resolve.'

  const system = `Given a list of open golf bets (JSON) and a message resolving one of them, figure out
which bet is being resolved and who won. Respond ONLY with raw JSON, no markdown fences:
{"id": string, "winner": string} or, if you can't confidently match it, {"error": "no match"}

Open bets: ${JSON.stringify(openBets)}`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    system,
    messages: [{ role: 'user', content: `Message sender: ${senderName}\nMessage: ${text}` }]
  })

  const raw = response.content.find((b) => b.type === 'text')?.text?.trim()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return "Couldn't match that to an open bet - try mentioning the names or condition from the original bet."
  }
  if (parsed.error) {
    return "Couldn't match that to an open bet - try mentioning the names or condition from the original bet."
  }

  const rows = await getAllRows()
  const rowIndex = rows.findIndex((r) => r[0] === parsed.id)
  if (rowIndex === -1) return "Couldn't find that bet in the sheet."

  const sheets = await getSheetsClient()
  const rowNum = rowIndex + 1 // 1-indexed, matches sheet row numbers

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!F${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['resolved']] }
  })

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!H${rowNum}:I${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[parsed.winner, new Date().toISOString()]] }
  })

  return `Resolved bet ${parsed.id}: ${parsed.winner} wins! 🍺`
}

export async function getTally() {
  const rows = await getAllRows()
  const resolved = rows.slice(1).filter((r) => r[5] === 'resolved')
  if (resolved.length === 0) return 'No resolved bets yet.'

  const tally = {}
  for (const r of resolved) {
    const winner = r[7]
    if (!winner) continue
    tally[winner] = (tally[winner] || 0) + 1
  }

  const lines = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}: ${count} beer${count === 1 ? '' : 's'} owed`)

  return `🍺 Beer tally:\n${lines.join('\n')}`
}
