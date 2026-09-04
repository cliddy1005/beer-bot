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
  const rows = await getAllRows()
  const id = `B${rows.length}` // header is row 1, so row count = next bet number

  const sheets = await getSheetsClient()
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: RANGE_ALL,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        [id, bet.bettor, bet.opponent, bet.condition, bet.stake, bet.status, new Date().toISOString()]
      ]
    }
  })

  return id
}

async function getAllRows() {
  const sheets = await getSheetsClient()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE_ALL })
  return res.data.values || []
}

export async function getAllBets() {
  const rows = await getAllRows()
  return rows.slice(1).map((r) => ({
    id: r[0],
    bettor: r[1],
    opponent: r[2],
    condition: r[3],
    stake: r[4],
    status: r[5],
    createdAt: r[6],
    winner: r[7] || null,
    resolvedAt: r[8] || null
  }))
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

  const system = `Given a list of open golf bets (JSON) and a message with new information, figure out
which open bet this is about and whether its "condition" happened.

Rules for deciding the winner:
- The "bettor" staked that the "condition" would happen. If the message confirms the condition
  happened, "bettor" wins. If the message shows it did NOT happen (including the opposite outcome),
  "opponent" wins.
- Reason carefully about whether the message actually satisfies the exact condition text - don't
  assume, check it. Golf scoring reminder: birdie = 1 under par, par = even, bogey = 1 over par,
  double bogey = 2 over par. These are different outcomes, not synonyms - a birdie is not a bogey.
- If the message doesn't clearly resolve any open bet, or you're not confident, don't guess.

Respond ONLY with raw JSON, no markdown fences. First explain your reasoning in one short sentence,
then give the verdict:
{"id": string, "reasoning": string, "conditionMet": boolean, "winnerRole": "bettor" | "opponent"}
or, if you can't confidently match it, {"error": "no match"}

Open bets: ${JSON.stringify(openBets)}`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
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
  if (parsed.error || !['bettor', 'opponent'].includes(parsed.winnerRole)) {
    return "Couldn't match that to an open bet - try mentioning the names or condition from the original bet."
  }

  const rows = await getAllRows()
  const rowIndex = rows.findIndex((r) => r[0] === parsed.id)
  if (rowIndex === -1) return "Couldn't find that bet in the sheet."

  const row = rows[rowIndex]
  const winner = parsed.winnerRole === 'bettor' ? row[1] : row[2]
  const loser = parsed.winnerRole === 'bettor' ? row[2] : row[1]

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
    requestBody: { values: [[winner, new Date().toISOString()]] }
  })

  await updateTotalsForPlayers([winner, loser])

  const beers = parseBeerCount(row[4])
  return `Resolved bet ${parsed.id}: ${winner} wins! 🍺 ${loser} +${beers} to their fine count, ${winner} -${beers}.`
}

function parseBeerCount(stake) {
  const match = String(stake).match(/\d+/)
  return match ? parseInt(match[0], 10) : 1
}

function computeTally(rows, offsets = {}) {
  const resolved = rows.slice(1).filter((r) => r[5] === 'resolved' && r[7])
  const tally = { ...offsets }
  for (const r of resolved) {
    const bettor = r[1]
    const opponent = r[2]
    const winner = r[7]
    const loser = winner === bettor ? opponent : bettor
    const beers = parseBeerCount(r[4])

    tally[winner] = (tally[winner] || 0) - beers
    tally[loser] = (tally[loser] || 0) + beers
  }
  return tally
}

export async function getTallyData() {
  const rows = await getAllRows()
  const offsets = await getStartingBalances()
  const tally = computeTally(rows, offsets)
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }))
}

export async function getTally() {
  const rows = await getAllRows()
  const offsets = await getStartingBalances()
  const tally = computeTally(rows, offsets)
  if (Object.keys(tally).length === 0) return 'No resolved bets yet.'

  const lines = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}: ${count} beer${count === 1 || count === -1 ? '' : 's'}`)

  return `🍺 Beer fine totals:\n${lines.join('\n')}`
}

const TOTALS_SHEET_NAME = 'Totals'
const STARTING_BALANCES_SHEET_NAME = 'StartingBalances'

async function ensureSheetExists(sheets, name) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID })
  const exists = meta.data.sheets.some((s) => s.properties.title === name)
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: name } } }] }
    })
  }
}

export async function getStartingBalances() {
  const sheets = await getSheetsClient()
  await ensureSheetExists(sheets, STARTING_BALANCES_SHEET_NAME)

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${STARTING_BALANCES_SHEET_NAME}!A:B`
  })
  const rows = res.data.values || []

  const offsets = {}
  for (const [name, offset] of rows.slice(1)) {
    if (name) offsets[name] = Number(offset) || 0
  }
  return offsets
}

async function getTotalsRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TOTALS_SHEET_NAME}!A:B`
  })
  return res.data.values || []
}

export async function updateTotalsForPlayers(names) {
  const rows = await getAllRows()
  const offsets = await getStartingBalances()
  const tally = computeTally(rows, offsets)

  const sheets = await getSheetsClient()
  await ensureSheetExists(sheets, TOTALS_SHEET_NAME)

  let totalsRows = await getTotalsRows(sheets)
  if (totalsRows.length === 0) {
    totalsRows = [['Player', 'Beers']]
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TOTALS_SHEET_NAME}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: totalsRows }
    })
  }

  for (const name of names) {
    const value = tally[name] || 0
    const rowIndex = totalsRows.findIndex((r, i) => i > 0 && r[0] === name)

    if (rowIndex === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${TOTALS_SHEET_NAME}!A:B`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[name, value]] }
      })
      totalsRows.push([name, value])
    } else {
      const rowNum = rowIndex + 1 // 1-indexed, matches sheet row numbers
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${TOTALS_SHEET_NAME}!B${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[value]] }
      })
    }
  }
}
