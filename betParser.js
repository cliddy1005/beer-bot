import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You extract structured golf beer bets from casual WhatsApp messages.
Respond ONLY with raw JSON, no markdown fences, no commentary, matching exactly this shape:

{"bettor": string, "opponent": string, "condition": string, "stake": string}

- "bettor" is the person making the claim/bet (use the sender's name if the message doesn't say otherwise).
- "opponent" is who they're betting against.
- "condition" is a short plain-English description of what has to happen for the bet to resolve.
- "stake" is what's being wagered, default to "a beer" if unspecified.

If the message clearly isn't a bet (e.g. it's a question, a resolve/tally command, or just chat),
respond with exactly: {"error": "not a bet"}`

export async function classifyIntent(text, openBets) {
  const system = `You are the message router for a golf beer-bet WhatsApp bot. Given a message
and the list of currently open bets (JSON), classify the message's intent as exactly one of:

- "tally": asking for beer fine totals - the running count of beers each player currently owes
  (can be negative, meaning they're in credit) - e.g. "tally", "how many beers does Dave owe",
  "what are the totals", "how's everyone doing"
- "resolve": reporting a result, score, or outcome relevant to one of the open bets - this
  includes explicit resolutions ("Dave broke 90, I win") AND raw updates like final scores
  that let you work out who won an open bet even if the message doesn't say so directly
  (e.g. "Ciaran scored 14 points on the par 5s, Storm scored 12")
- "bet": proposing a brand new bet, unrelated to any open bet
- "question": asking about the bets themselves (not totals, not reporting a result) - e.g.
  "summarize the bets", "what's left to decide", "what's Dave got on", "any bets outstanding?"
- "other": anything else (chit-chat, too ambiguous to act on)

If there are no open bets, "resolve" is never correct - prefer "bet", "question", or "other".
Respond ONLY with raw JSON, no markdown fences:
{"intent": "tally" | "resolve" | "bet" | "question" | "other"}

Open bets: ${JSON.stringify(openBets)}`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 50,
    system,
    messages: [{ role: 'user', content: text }]
  })

  const raw = response.content.find((b) => b.type === 'text')?.text?.trim()
  try {
    const parsed = JSON.parse(raw)
    if (['tally', 'resolve', 'bet', 'question', 'other'].includes(parsed.intent)) return parsed.intent
  } catch {
    // fall through
  }
  return 'other'
}

export async function answerQuestion(text, allBets) {
  const system = `You are BeerBot, a WhatsApp bot that tracks golf beer bets for a group chat.
Answer the user's question about the bets below, in plain WhatsApp-friendly text (no markdown
headers or tables - short lines and emoji are fine). Be concise. Use bet IDs when referring to
specific bets so people can resolve/reference them later. If the answer would be empty (e.g. no
open bets), say so plainly.

All bets (JSON, status is "open" or "resolved"): ${JSON.stringify(allBets)}`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system,
    messages: [{ role: 'user', content: text }]
  })

  return response.content.find((b) => b.type === 'text')?.text?.trim() || "Couldn't work that out - try rephrasing."
}

export async function parseBet(text, senderName) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: `Message sender: ${senderName}\nMessage: ${text}` }
    ]
  })

  const raw = response.content.find((b) => b.type === 'text')?.text?.trim()
  if (!raw) return null

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (parsed.error) return null

  return {
    status: 'open',
    createdBy: senderName,
    bettor: parsed.bettor,
    opponent: parsed.opponent,
    condition: parsed.condition,
    stake: parsed.stake
  }
}
