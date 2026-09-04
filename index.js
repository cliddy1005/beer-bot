import 'dotenv/config'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import { parseBet } from './betParser.js'
import { addBet, resolveBet, getTally } from './sheets.js'

const GROUP_JID = process.env.GOLF_GROUP_JID || null

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      console.log('Scan this QR code from the BeerBot WhatsApp account:')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('Connection closed.', shouldReconnect ? 'Reconnecting...' : 'Logged out - delete the auth/ folder and rescan.')
      if (shouldReconnect) start()
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

  const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
  const botNumber = sock.user.id.split(':')[0]
  const botLid = sock.authState.creds.me?.lid?.split(':')[0]
  const mentioned = mentions.some((jid) => jid.startsWith(botNumber) || (botLid && jid.startsWith(botLid)))
  if (!mentioned) return

  const senderJid = msg.key.participant || msg.key.remoteJid
  const senderName = msg.pushName || senderJid

  await handleCommand({ sock, chatJid, senderJid, senderName, text })
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    null
  )
}

async function handleCommand({ sock, chatJid, senderJid, senderName, text }) {
  // strip the @mention tokens (digits) out of the message before parsing
  const clean = text.replace(/@\d+/g, '').trim()

  if (/^tally\b/i.test(clean)) {
    const tally = await getTally()
    await sock.sendMessage(chatJid, { text: tally })
    return
  }

  if (/^(resolve|won|lost|broke|beat)\b/i.test(clean)) {
    const result = await resolveBet(clean, senderName)
    await sock.sendMessage(chatJid, { text: result })
    return
  }

  const bet = await parseBet(clean, senderName)
  if (!bet) {
    await sock.sendMessage(chatJid, {
      text:
        "Couldn't parse that as a bet. Try something like:\n" +
        '"@BeerBot Dave owes me a beer if he doesn\'t break 90"'
    })
    return
  }

  await addBet(bet)
  await sock.sendMessage(chatJid, {
    text: `Logged 🍺 ${bet.bettor} vs ${bet.opponent} — ${bet.condition} (stake: ${bet.stake})\nBet ID: ${bet.id}`
  })
}

start()
