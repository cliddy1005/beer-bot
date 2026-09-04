import http from 'node:http'
import { getAllBets, getTallyData } from './sheets.js'

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>BeerBot Dashboard</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f1115; color:#e6e6e6; margin:0; padding:24px; }
  h1 { font-size:20px; margin-bottom:4px; }
  .sub { color:#888; font-size:13px; margin-bottom:24px; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:24px; }
  @media (max-width:900px) { .grid { grid-template-columns: 1fr; } }
  section { background:#181b21; border:1px solid #262a33; border-radius:10px; padding:16px; margin-bottom:24px; }
  section h2 { margin-top:0; font-size:15px; color:#aab; text-transform:uppercase; letter-spacing:.04em; }
  table { width:100%; border-collapse: collapse; font-size:14px; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid #262a33; }
  th { color:#888; font-weight:500; }
  .beers-pos { color:#f5786a; }
  .beers-neg { color:#5fd97a; }
  .beers-zero { color:#aab; }
  .empty { color:#666; padding:8px 0; }
</style>
</head>
<body>
  <h1>🍺 BeerBot Dashboard</h1>
  <div class="sub" id="updated">Loading...</div>
  <div class="grid">
    <section>
      <h2>Open bets</h2>
      <table id="openTable"><thead><tr><th>ID</th><th>Bettor</th><th>Opponent</th><th>Condition</th><th>Stake</th></tr></thead><tbody></tbody></table>
      <div class="empty" id="openEmpty" style="display:none">No open bets.</div>
    </section>
    <section>
      <h2>Totals</h2>
      <table id="totalsTable"><thead><tr><th>Player</th><th>Beers</th></tr></thead><tbody></tbody></table>
      <div class="empty" id="totalsEmpty" style="display:none">No resolved bets yet.</div>
    </section>
  </div>
  <section>
    <h2>Resolved bets</h2>
    <table id="resolvedTable"><thead><tr><th>ID</th><th>Bettor</th><th>Opponent</th><th>Condition</th><th>Stake</th><th>Winner</th><th>Resolved</th></tr></thead><tbody></tbody></table>
    <div class="empty" id="resolvedEmpty" style="display:none">No resolved bets yet.</div>
  </section>

<script>
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

async function refresh() {
  const res = await fetch('/api/data')
  const data = await res.json()

  document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString()

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

  document.querySelector('#totalsTable tbody').innerHTML = data.totals.map((t) => {
    const cls = t.count > 0 ? 'beers-pos' : t.count < 0 ? 'beers-neg' : 'beers-zero'
    return \`<tr><td>\${escapeHtml(t.name)}</td><td class="\${cls}">\${t.count}</td></tr>\`
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

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(PAGE)
  })

  server.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`)
  })
}
