# beer-bot

Tag it in your golf WhatsApp group to log and settle beer bets automatically.

Uses [Baileys](https://github.com/WhiskeySockets/Baileys) to run as a real WhatsApp
account (so it can actually sit inside your existing group), Claude to parse messy
bet phrasing into structured data, and a Google Sheet as the ledger.

## 1. Prerequisites

- Node.js 18+
- A spare phone number for the bot (a cheap eSIM or old SIM). **Don't use your main
  number** - this connects as a real WhatsApp account via an unofficial client, and
  while risk is low, it's not sanctioned by WhatsApp.
- An [Anthropic API key](https://console.anthropic.com)
- A Google account for the ledger sheet

## 2. Create the ledger sheet

1. Create a new Google Sheet.
2. Rename the first tab to `Bets`.
3. Add this header row: `id | bettor | opponent | condition | stake | status | createdAt | winner | resolvedAt`
4. Copy the Sheet ID out of the URL (`https://docs.google.com/spreadsheets/d/THIS_PART/edit`).

## 3. Set up a Google service account

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Google Sheets API**.
2. Create a service account, then create a JSON key for it and download it as `service-account.json` into this folder.
3. Open your Sheet, click Share, and share it (Editor access) with the service account's email address (looks like `something@project-id.iam.gserviceaccount.com`).

## 4. Configure

```bash
cp .env.example .env
```

Fill in `ANTHROPIC_API_KEY`, `GOOGLE_SHEET_ID`, and `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`.
Leave `GOLF_GROUP_JID` blank for now.

## 5. Install and run

```bash
npm install
npm start
```

A QR code prints in the terminal. Scan it from WhatsApp on the **bot's** phone
number: Settings → Linked Devices → Link a Device.

## 6. Find your group's JID

With `GOLF_GROUP_JID` still blank, add the bot's WhatsApp account to your golf
group like a normal contact, then send any message in the group. The console
will print:

```
[discovery] message seen in group JID: 123456789012345678@g.us
```

Copy that into `.env` as `GOLF_GROUP_JID`, then restart (`npm start`).

## 7. Use it

In the group, tag the bot's contact name and describe the bet:

```
@BeerBot @Dave owes me a beer if he doesn't break 90 today
```

You must tag the person you're betting against (in addition to tagging BeerBot) - bets
without an opponent tag are rejected, so there's no ambiguity about who's on the hook.

Resolve it later:

```
@BeerBot Dave broke 90, I win
```

Check the running total any time:

```
@BeerBot tally
```

## Troubleshooting

- **Tagging the bot does nothing, no console output at all**: make sure `npm start`
  is actually running in a terminal - the bot only reacts while the process is up.
- **Bot is running and connected, but a tagged message still gets no reply**: some
  WhatsApp accounts get mentioned using a `@lid` (linked-device ID) instead of their
  phone-number JID. The bot checks both (`sock.user.id` and
  `sock.authState.creds.me.lid`) - if you're still stuck, temporarily log
  `msg.message.extendedTextMessage.contextInfo.mentionedJid` in `handleMessage` to
  see what WhatsApp is actually sending.
- **`GOLF_GROUP_JID is not set` messages, or messages seemingly ignored after
  setting it**: if the JID in `.env` doesn't match the group anymore, matching
  messages are dropped silently with no log line - re-run the discovery step
  (blank out `GOLF_GROUP_JID` and restart) to confirm the current JID.
- **`Could not resolve authentication method` / 400 credit balance errors** from
  Anthropic: `ANTHROPIC_API_KEY` is missing or the account is out of credits - check
  Plans & Billing at [console.anthropic.com](https://console.anthropic.com).
- **`ENOENT ... service-account.json`**: the service account key isn't in place yet,
  or `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` points somewhere else - see step 3 above.
- **Google Sheets errors after the key is in place**: double check you shared the
  sheet with the service account's `...iam.gserviceaccount.com` email as an Editor.

## Notes / things to tighten up before relying on this

- Bet matching on resolve is LLM-based fuzzy matching against open bets - it works
  well for a small group but double check the "Resolved bet ..." reply matches
  what you meant before trusting it.
- Only one `GOLF_GROUP_JID` is supported right now; extend `index.js` if you want
  the bot in multiple groups.
- The `auth/` folder holds your WhatsApp session - keep it out of git (see
  `.gitignore`) and don't lose it, or you'll need to re-scan the QR code.
- Consider adding an admin-only `@BeerBot delete <id>` command for correcting
  mistaken entries - not included here to keep the skeleton small.
