import 'dotenv/config'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import { parseBet, classifyIntent, answerQuestion } from './betParser.js'
import { addBet, resolveBet, resolveBetById, getTally, getOpenBets, getAllBets } from './sheets.js'
import { startDashboard } from './dashboard.js'

const GROUP_JID = process.env.GOLF_GROUP_JID || null
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 3000
const HOME_DESTINATION = process.env.HOME_DESTINATION || null
const HOME_LAT = process.env.HOME_LAT || null
const HOME_LNG = process.env.HOME_LNG || null

const HELP_TEXT = `🍺 I'm BeerBot - I track golf beer bets for this group.

Log a new bet (you must tag who you're betting against, not just me):
"@BeerBot @Dave owes me a beer if he doesn't break 90"

Resolve a bet - either describe the outcome:
"@BeerBot Dave broke 90, I win"
...or just reply directly to my "Logged 🍺 ..." confirmation message and say who won -
I'll resolve that exact bet.

Check totals:
"@BeerBot tally"

Ask me things (bets or trip logistics, if I've been given trip context):
"@BeerBot what's left to decide?" / "@BeerBot what time do we tee off tomorrow?"

Get directions home:
"@BeerBot get me home"

Everything's also viewable live at the dashboard (ask whoever's running me for the link).`

// jid -> display name, built up from WhatsApp's contact sync so @mentions can be
// resolved to real names (mentions only carry a JID, never a name)
const contactsCache = new Map()

// Guards against overlapping start() calls - a single disconnect can otherwise trigger
// it twice (once from connection.update's close handler, once from unhandledRejection),
// each creating a new socket with its own listeners that's never torn down, compounding
// into an unbounded number of live sockets and an eventual out-of-memory crash.
let reconnectScheduled = false
function scheduleReconnect() {
  if (reconnectScheduled) return
  reconnectScheduled = true
  setTimeout(() => {
    reconnectScheduled = false
    start()
  }, 3000)
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      const name = c.name || c.notify
      if (name) contactsCache.set(c.id, name)
    }
  })

  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      const name = u.name || u.notify
      if (name && u.id) contactsCache.set(u.id, name)
    }
  })

  sock.ev.on('messaging-history.set', ({ contacts }) => {
    for (const c of contacts || []) {
      const name = c.name || c.notify
      if (name) contactsCache.set(c.id, name)
    }
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      console.log('Scan this QR code from the BeerBot WhatsApp account:')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('Connection closed.', shouldReconnect ? 'Reconnecting in 3s...' : 'Logged out - delete the auth/ folder and rescan.')
      if (shouldReconnect) scheduleReconnect()
    } else if (connection === 'open') {
      console.log('BeerBot is connected. Bot JID:', sock.user.id)
      if (!GROUP_JID) {
        console.log('GOLF_GROUP_JID is not set - watch the console below for group JIDs as messages come in.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg)
      } catch (err) {
        console.error('Error handling message:', err)
      }
    }
  })
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return

  const chatJid = msg.key.remoteJid
  const isGroup = chatJid?.endsWith('@g.us')

  // Discovery mode: log every group JID so you can find the golf group's ID
  if (isGroup && !GROUP_JID) {
    console.log(`[discovery] message seen in group JID: ${chatJid}`)
  }

  if (!isGroup) return
  if (GROUP_JID && chatJid !== GROUP_JID) return

  const text = extractText(msg)
  if (!text) return

  const quotedText = extractText({ message: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage })
  const quotedBetId = quotedText?.match(/Bet ID:\s*(\S+)/)?.[1] || null

  const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
  const botNumber = sock.user.id.split(':')[0]
  const botLid = sock.authState.creds.me?.lid?.split(':')[0]
  const isBotMention = (jid) => jid.startsWith(botNumber) || (botLid && jid.startsWith(botLid))
  const mentioned = mentions.some(isBotMention)
  if (!mentioned) return

  const otherMentions = mentions.filter((jid) => !isBotMention(jid))
  const senderJid = msg.key.participant || msg.key.remoteJid
  const senderName = msg.pushName || senderJid
  if (msg.pushName) contactsCache.set(senderJid, msg.pushName)

  const taggedNames = otherMentions.map((jid) => contactsCache.get(jid)).filter(Boolean)

  await handleCommand({ sock, chatJid, senderJid, senderName, text, otherMentions, taggedNames, quotedBetId })
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    null
  )
}

async function handleCommand({ sock, chatJid, senderJid, senderName, text, otherMentions, taggedNames, quotedBetId }) {
  // strip the @mention tokens (digits) out of the message before parsing
  const clean = text.replace(/@\d+/g, '').trim()

  const openBets = await getOpenBets()
  const intent = await classifyIntent(clean, openBets)

  if (intent === 'tally') {
    const tally = await getTally()
    await sock.sendMessage(chatJid, { text: tally })
    return
  }

  if (intent === 'resolve') {
    const result = quotedBetId
      ? (await resolveBetById(quotedBetId, clean, senderName)) ?? (await resolveBet(clean, senderName))
      : await resolveBet(clean, senderName)
    await sock.sendMessage(chatJid, { text: result })
    return
  }

  if (intent === 'help') {
    await sock.sendMessage(chatJid, { text: HELP_TEXT })
    return
  }

  if (intent === 'directions') {
    if (!HOME_DESTINATION) {
      await sock.sendMessage(chatJid, { text: 'No destination configured - set HOME_DESTINATION in .env.' })
      return
    }
    const mapsLink = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(HOME_DESTINATION)}`

    let reply = `🏌️ Directions to ${HOME_DESTINATION}:\n${mapsLink}`
    if (HOME_LAT && HOME_LNG) {
      // Uber needs actual lat/lng to auto-set the dropoff pin - formatted_address alone is
      // just display text and won't fill in the destination.
      const uberLink = `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${HOME_LAT}&dropoff[longitude]=${HOME_LNG}&dropoff[formatted_address]=${encodeURIComponent(HOME_DESTINATION)}`
      reply += `\n\n🚗 Get an Uber there:\n${uberLink}`
    }
    await sock.sendMessage(chatJid, { text: reply })
    return
  }

  if (intent === 'question') {
    const allBets = await getAllBets()
    const answer = await answerQuestion(clean, allBets)
    await sock.sendMessage(chatJid, { text: answer })
    return
  }

  if (intent === 'bet') {
    if (otherMentions.length === 0) {
      await sock.sendMessage(chatJid, {
        text: "Tag who you're betting against to log this one - e.g. \"@BeerBot @Dave owes me a beer if he doesn't break 90\""
      })
      return
    }

    const bet = await parseBet(clean, senderName, taggedNames)
    if (!bet) {
      await sock.sendMessage(chatJid, {
        text:
          "Couldn't parse that as a bet. Try something like:\n" +
          '"@BeerBot Dave owes me a beer if he doesn\'t break 90"'
      })
      return
    }

    const id = await addBet(bet)
    await sock.sendMessage(chatJid, {
      text: `Logged 🍺 ${bet.bettor} vs ${bet.opponent} — ${bet.condition} (stake: ${bet.stake})\nBet ID: ${id}`
    })
    return
  }

  await sock.sendMessage(chatJid, { text: `Not sure what to do with that.\n\n${HELP_TEXT}` })
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection - reconnecting in 3s:', err)
  scheduleReconnect()
})

startDashboard(DASHBOARD_PORT)
start()
