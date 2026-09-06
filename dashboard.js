import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { getAllBets, getTallyData } from './sheets.js'

const MASCOT_PATH = path.join(process.cwd(), 'assets', 'mascot.png')

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>BeerBot Bets</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&family=Courier+Prime:ital@0;1&display=swap" rel="stylesheet">
<style>
  :root {
    --slate: #141d18;
    --chalk: #f1ece0;
    --chalk-dim: #a9a190;
    --gold: #e2a83c;
    --gold-deep: #b9791f;
    --forest: #26402f;
    --forest-light: #335a41;
    --copper: #b97a4c;
    --paper: #f3ead2;
    --paper-line: #d9c9a3;
    --ink: #2c2013;
    --ink-dim: #7a684a;
    --flag: #b5382c;
    --settled: #3f7a54;
  }

  * { box-sizing: border-box; }

  body {
    background: var(--slate);
    color: var(--chalk);
    font-family: 'Courier Prime', 'Courier New', monospace;
    margin: 0;
    padding: 32px 24px 48px;
  }

  .wrap { max-width: 960px; margin: 0 auto; }

  .banner {
    display: flex;
    align-items: center;
    gap: 18px;
    margin-bottom: 10px;
  }

  .mascot {
    width: 60px;
    height: 60px;
    border-radius: 50%;
    object-fit: cover;
    border: 3px solid var(--gold);
    flex-shrink: 0;
    background: var(--forest);
  }

  .mascot.hidden { display: none; }

  h1 {
    font-family: 'Kalam', cursive;
    font-weight: 700;
    font-size: 38px;
    margin: 0;
    color: var(--chalk);
    text-shadow: 1px 1px 0 rgba(255,255,255,0.08);
  }

  .sub {
    font-style: italic;
    color: var(--chalk-dim);
    font-size: 13px;
    margin: 4px 0 0 78px;
  }

  .tartan-rule {
    height: 7px;
    margin: 18px 0 28px;
    border-radius: 2px;
    background: repeating-linear-gradient(
      45deg,
      var(--forest) 0 10px,
      var(--forest-light) 10px 14px,
      var(--gold-deep) 14px 18px
    );
  }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
  @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }

  section.ledger {
    background: var(--paper);
    color: var(--ink);
    border-radius: 6px;
    padding: 18px 20px;
    margin-bottom: 22px;
    box-shadow: 0 5px 0 rgba(0,0,0,0.35);
  }

  section.ledger h2 {
    font-family: 'Kalam', cursive;
    font-weight: 700;
    font-size: 19px;
    color: var(--forest);
    margin: 0 0 12px;
    border-bottom: 2px dashed var(--paper-line);
    padding-bottom: 8px;
  }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 7px 8px; }
  th {
    color: var(--ink-dim);
    font-weight: 700;
    font-variant: small-caps;
    letter-spacing: 0.02em;
    border-bottom: 1px solid var(--paper-line);
  }
  td { border-bottom: 1px dashed var(--paper-line); }
  tr:last-child td { border-bottom: none; }

  .total-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 11px 2px;
    border-bottom: 1px dashed var(--paper-line);
  }
  .total-row:last-child { border-bottom: none; }
  .total-name { font-family: 'Kalam', cursive; font-size: 16px; }
  .total-count { font-family: 'Kalam', cursive; font-weight: 700; font-size: 22px; }
  .owes { color: var(--flag); }
  .settled { color: var(--settled); }
  .even { color: var(--ink-dim); }

  .empty {
    font-style: italic;
    color: var(--ink-dim);
    padding: 6px 2px;
  }

  footer {
    text-align: center;
    font-family: 'Kalam', cursive;
    color: var(--chalk-dim);
    font-style: italic;
    font-size: 14px;
    margin-top: 8px;
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="banner">
    <img class="mascot" id="mascotImg" src="/mascot.png" alt="BeerBot">
    <h1>BeerBot Bets</h1>
  </div>
  <div class="sub" id="updated">Loading...</div>
  <div class="tartan-rule"></div>

  <div class="grid">
    <section class="ledger">
      <h2>Open bets</h2>
      <table id="openTable"><thead><tr><th>ID</th><th>Bettor</th><th>Opponent</th><th>Condition</th><th>Stake</th></tr></thead><tbody></tbody></table>
      <div class="empty" id="openEmpty" style="display:none">&mdash; no bets on the books &mdash;</div>
    </section>

    <section class="ledger">
      <h2>Totals</h2>
      <div id="totalsList"></div>
      <div class="empty" id="totalsEmpty" style="display:none">&mdash; nobody owes anybody, yet &mdash;</div>
    </section>
  </div>

  <section class="ledger">
    <h2>Resolved bets</h2>
    <table id="resolvedTable"><thead><tr><th>ID</th><th>Bettor</th><th>Opponent</th><th>Condition</th><th>Stake</th><th>Winner</th><th>Resolved</th></tr></thead><tbody></tbody></table>
    <div class="empty" id="resolvedEmpty" style="display:none">&mdash; no bets on the books &mdash;</div>
  </section>

  <footer>Beer payouts only.</footer>

</div>
<script>
document.getElementById('mascotImg').addEventListener('error', function () {
  this.classList.add('hidden')
})

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

async function refresh() {
  const res = await fetch('/api/data')
  const data = await res.json()

  document.getElementById('updated').textContent = 'Last updated ' + new Date().toLocaleTimeString()

  const open = data.bets.filter((b) => b.status === 'open')
  const resolved = data.bets.filter((b) => b.status === 'resolved')

  document.querySelector('#openTable tbody').innerHTML = open.map((b) =>
    \`<tr><td>\${escapeHtml(b.id)}</td><td>\${escapeHtml(b.bettor)}</td><td>\${escapeHtml(b.opponent)}</td><td>\${escapeHtml(b.condition)}</td><td>\${escapeHtml(b.stake)}</td></tr>\`
  ).join('')
  document.getElementById('openEmpty').style.display = open.length ? 'none' : 'block'

  document.querySelector('#resolvedTable tbody').innerHTML = resolved.map((b) =>
    \`<tr><td>\${escapeHtml(b.id)}</td><td>\${escapeHtml(b.bettor)}</td><td>\${escapeHtml(b.opponent)}</td><td>\${escapeHtml(b.condition)}</td><td>\${escapeHtml(b.stake)}</td><td>\${escapeHtml(b.winner)}</td><td>\${b.resolvedAt ? new Date(b.resolvedAt).toLocaleString() : ''}</td></tr>\`
  ).join('')
  document.getElementById('resolvedEmpty').style.display = resolved.length ? 'none' : 'block'

  document.getElementById('totalsList').innerHTML = data.totals.map((t) => {
    const cls = t.count > 0 ? 'owes' : t.count < 0 ? 'settled' : 'even'
    const label = Math.abs(t.count) === 1 ? 'fine' : 'fines'
    return \`<div class="total-row"><span class="total-name">\${escapeHtml(t.name)}</span><span class="total-count \${cls}">\${Math.abs(t.count)} \${label}</span></div>\`
  }).join('')
  document.getElementById('totalsEmpty').style.display = data.totals.length ? 'none' : 'block'
}

refresh()
setInterval(refresh, 5000)
</script>
</body>
</html>`

export function startDashboard(port) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/data') {
      try {
        const [bets, totals] = await Promise.all([getAllBets(), getTallyData()])
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ bets, totals }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    if (req.url === '/mascot.png') {
      fs.readFile(MASCOT_PATH, (err, buf) => {
        if (err) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(buf)
      })
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(PAGE)
  })

  server.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`)
  })
}