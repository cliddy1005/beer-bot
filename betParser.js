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
    id: Date.now().toString(36),
    status: 'open',
    createdBy: senderName,
    bettor: parsed.bettor,
    opponent: parsed.opponent,
    condition: parsed.condition,
    stake: parsed.stake
  }
}
