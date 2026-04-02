const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database setup ──────────────────────────────────────────
const db = new Database(path.join(__dirname, 'festa.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS convidados (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    grupo TEXT DEFAULT 'Amigos',
    confirmado INTEGER DEFAULT NULL,  -- null=pendente, 1=sim, 0=nao
    adultos INTEGER DEFAULT 1,
    criancas INTEGER DEFAULT 0,
    telefone TEXT DEFAULT '',
    conviteEnviado INTEGER DEFAULT 0,
    token TEXT UNIQUE
  );

  CREATE TABLE IF NOT EXISTS dados (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
`);

// ── Helpers ─────────────────────────────────────────────────
function gerarToken() {
  return crypto.randomBytes(8).toString('hex');
}

function tooBool(val) {
  if (val === null || val === undefined) return null;
  return val === 1 || val === true;
}

function rowToGuest(row) {
  return {
    id: row.id,
    nome: row.nome,
    grupo: row.grupo,
    confirmado: row.confirmado === null ? null : row.confirmado === 1,
    adultos: row.adultos,
    criancas: row.criancas,
    telefone: row.telefone || '',
    conviteEnviado: row.conviteEnviado === 1,
    token: row.token,
  };
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// CORS para dev local
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
  next();
});

// ── API: Convidados ──────────────────────────────────────────

// GET /api/convidados → lista todos
app.get('/api/convidados', (req, res) => {
  const rows = db.prepare('SELECT * FROM convidados ORDER BY id').all();
  res.json(rows.map(rowToGuest));
});

// POST /api/convidados → cria novo
app.post('/api/convidados', (req, res) => {
  const { nome, grupo = 'Amigos', adultos = 1, criancas = 0, telefone = '' } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
  const token = gerarToken();
  const stmt = db.prepare(
    'INSERT INTO convidados (nome, grupo, adultos, criancas, telefone, token) VALUES (?,?,?,?,?,?)'
  );
  const info = stmt.run(nome, grupo, adultos, criancas, telefone, token);
  const row = db.prepare('SELECT * FROM convidados WHERE id = ?').get(info.lastInsertRowid);
  res.json(rowToGuest(row));
});

// PUT /api/convidados/:id → atualiza
app.put('/api/convidados/:id', (req, res) => {
  const { id } = req.params;
  const fields = ['nome', 'grupo', 'adultos', 'criancas', 'telefone', 'confirmado', 'conviteEnviado'];
  const updates = [];
  const values = [];
  fields.forEach(f => {
    if (f in req.body) {
      updates.push(`${f} = ?`);
      let val = req.body[f];
      if (f === 'confirmado') val = val === null ? null : val ? 1 : 0;
      if (f === 'conviteEnviado') val = val ? 1 : 0;
      values.push(val);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar' });
  values.push(id);
  db.prepare(`UPDATE convidados SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const row = db.prepare('SELECT * FROM convidados WHERE id = ?').get(id);
  res.json(rowToGuest(row));
});

// DELETE /api/convidados/:id
app.delete('/api/convidados/:id', (req, res) => {
  db.prepare('DELETE FROM convidados WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── API: Dados extras (checklist, orcamento, cotacoes) ───────
app.get('/api/dados/:chave', (req, res) => {
  const row = db.prepare('SELECT valor FROM dados WHERE chave = ?').get(req.params.chave);
  if (!row) return res.json(null);
  res.json(JSON.parse(row.valor));
});

app.put('/api/dados/:chave', (req, res) => {
  const valor = JSON.stringify(req.body);
  db.prepare('INSERT INTO dados (chave, valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor')
    .run(req.params.chave, valor);
  res.json({ ok: true });
});

// ── CONFIRMAÇÃO PÚBLICA (link enviado no WhatsApp) ───────────
// GET /confirmar/:token → página de confirmação
app.get('/confirmar/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM convidados WHERE token = ?').get(req.params.token);
  if (!row) {
    return res.send(paginaErro('Link inválido ou expirado.'));
  }
  res.send(paginaConfirmacao(row));
});

// POST /confirmar/:token → salva resposta
app.post('/confirmar/:token', (req, res) => {
  const { resposta } = req.body; // "sim" ou "nao"
  const row = db.prepare('SELECT * FROM convidados WHERE token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Token inválido' });

  const confirmado = resposta === 'sim' ? 1 : 0;
  db.prepare('UPDATE convidados SET confirmado = ?, conviteEnviado = 1 WHERE token = ?')
    .run(confirmado, req.params.token);

  res.send(paginaObrigado(row.nome, resposta === 'sim'));
});

// ── HTML das páginas de confirmação ─────────────────────────
function paginaConfirmacao(guest) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Confirmar Presença - Festa do Arthur</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@700;900&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:linear-gradient(170deg,#800000,#CC0000 40%,#0a1628 80%);min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:'Nunito',sans-serif;color:#fff;padding:20px;}
    .card{background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.15);border-radius:24px;padding:36px 28px;max-width:400px;width:100%;text-align:center;backdrop-filter:blur(10px);}
    .spider{font-size:64px;margin-bottom:12px;}
    h1{font-family:'Bebas Neue',cursive;font-size:36px;letter-spacing:2px;margin-bottom:4px;}
    .sub{font-size:13px;color:rgba(255,255,255,.6);margin-bottom:8px;}
    .name{font-size:22px;font-weight:900;color:#FFD700;margin-bottom:24px;}
    .info{background:rgba(255,255,255,.08);border-radius:14px;padding:14px;margin-bottom:28px;font-size:13px;line-height:1.8;}
    .btns{display:flex;gap:12px;}
    button{flex:1;border:none;border-radius:14px;padding:16px;font-family:'Nunito',sans-serif;font-size:16px;font-weight:900;cursor:pointer;transition:transform .15s;}
    button:active{transform:scale(.95);}
    .sim{background:linear-gradient(135deg,#22C55E,#16A34A);color:#fff;}
    .nao{background:rgba(255,255,255,.12);color:rgba(255,255,255,.7);border:1px solid rgba(255,255,255,.2);}
    form{margin:0;}
    .already{background:rgba(255,215,0,.15);border:1px solid rgba(255,215,0,.4);border-radius:14px;padding:14px;margin-bottom:20px;font-size:13px;color:#FFD700;}
  </style>
</head>
<body>
  <div class="card">
    <div class="spider">🕷️</div>
    <h1>Homem Aranha em Ação!</h1>
    <div class="sub">Festa de aniversário do</div>
    <div style="font-family:'Bebas Neue',cursive;font-size:28px;letter-spacing:2px;margin-bottom:4px;">ARTHUR</div>
    <div class="sub" style="margin-bottom:16px;">📅 09 de Janeiro de 2027</div>
    <div class="name">Olá, ${guest.nome}! 👋</div>
    ${guest.confirmado !== null ? `<div class="already">${guest.confirmado ? '✅ Você já confirmou presença!' : '❌ Você já informou que não vai comparecer.'}<br/>Deseja alterar sua resposta?</div>` : ''}
    <div class="info">
      🎂 <strong>Aniversariante:</strong> Arthur<br/>
      📅 <strong>Data:</strong> 09/01/2027<br/>
      🕷️ <strong>Tema:</strong> Homem Aranha em Ação
    </div>
    <p style="font-size:14px;margin-bottom:16px;color:rgba(255,255,255,.8);">Você vai comparecer?</p>
    <div class="btns">
      <form method="POST" style="flex:1">
        <input type="hidden" name="resposta" value="sim"/>
        <button type="submit" class="sim">✅ Sim, vou!</button>
      </form>
      <form method="POST" style="flex:1">
        <input type="hidden" name="resposta" value="nao"/>
        <button type="submit" class="nao">❌ Não vou</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function paginaObrigado(nome, confirmado) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Obrigado! - Festa do Arthur</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@700;900&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:linear-gradient(170deg,#800000,#CC0000 40%,#0a1628 80%);min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:'Nunito',sans-serif;color:#fff;padding:20px;}
    .card{background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.15);border-radius:24px;padding:36px 28px;max-width:400px;width:100%;text-align:center;backdrop-filter:blur(10px);}
    h1{font-family:'Bebas Neue',cursive;font-size:40px;letter-spacing:2px;margin:16px 0 8px;}
    .msg{font-size:15px;color:rgba(255,255,255,.8);line-height:1.6;}
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:72px">${confirmado ? '🎉' : '😢'}</div>
    <h1>${confirmado ? 'Ótimo!' : 'Tudo bem!'}</h1>
    <p class="msg">
      ${confirmado
        ? `<strong>${nome}</strong>, sua presença foi confirmada!<br/>Te esperamos na festa do Arthur! 🕷️🎂`
        : `<strong>${nome}</strong>, sentiremos sua falta.<br/>Obrigado por avisar!`
      }
    </p>
    <p style="margin-top:24px;font-size:12px;color:rgba(255,255,255,.4);">Você já pode fechar esta página.</p>
  </div>
</body>
</html>`;
}

function paginaErro(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Erro</title></head>
<body style="background:#0a1628;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;">
<div><div style="font-size:48px">😕</div><h2 style="margin:16px 0 8px">Link inválido</h2><p style="color:rgba(255,255,255,.6)">${msg}</p></div>
</body></html>`;
}

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Festa do Arthur rodando na porta ${PORT}`);
});
