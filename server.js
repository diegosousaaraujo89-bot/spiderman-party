const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database setup (PostgreSQL) ──────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  // Create tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS convidados (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      grupo TEXT DEFAULT 'Amigos',
      confirmado INTEGER DEFAULT NULL,
      adultos INTEGER DEFAULT 1,
      criancas INTEGER DEFAULT 0,
      telefone TEXT DEFAULT '',
      "conviteEnviado" INTEGER DEFAULT 0,
      token TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS dados (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );
  `);
  // Add new columns if they don't exist yet (migration)
  const migrations = [
    `ALTER TABLE convidados ADD COLUMN IF NOT EXISTS "idadeCrianca" TEXT DEFAULT ''`,
    `ALTER TABLE convidados ADD COLUMN IF NOT EXISTS "nomes" TEXT DEFAULT ''`,
  ];
  for (const sql of migrations) {
    await pool.query(sql).catch(()=>{});
  }
  console.log('Banco pronto!');
}
initDB().catch(err => console.error('Erro ao iniciar banco:', err));

// ── Helpers ──────────────────────────────────────────────────
function gerarToken() { return crypto.randomBytes(8).toString('hex'); }

function rowToGuest(row) {
  return {
    id: row.id,
    nome: row.nome,
    grupo: row.grupo,
    confirmado: row.confirmado === null ? null : Number(row.confirmado) === 1,
    adultos: row.adultos,
    criancas: row.criancas,
    telefone: row.telefone || '',
    conviteEnviado: Number(row.conviteEnviado) === 1,
    idadeCrianca: row.idadeCrianca || '',
    nomes: row.nomes || '',
    token: row.token,
  };
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── API: Convidados ──────────────────────────────────────────
app.get('/api/convidados', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM convidados ORDER BY id');
    res.json(rows.map(rowToGuest));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/convidados', async (req, res) => {
  try {
    const { nome, grupo = 'Amigos', adultos = 1, criancas = 0, telefone = '', idadeCrianca = '', nomes = '' } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
    const token = gerarToken();
    const { rows } = await pool.query(
      'INSERT INTO convidados (nome, grupo, adultos, criancas, telefone, "idadeCrianca", "nomes", token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [nome, grupo, adultos, criancas, telefone, idadeCrianca||'', nomes||'', token]
    );
    res.json(rowToGuest(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/convidados/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['nome','grupo','adultos','criancas','telefone','confirmado','conviteEnviado','idadeCrianca','nomes'];
    const updates = []; const values = []; let i = 1;
    allowed.forEach(f => {
      if (f in req.body) {
        updates.push(`"${f}" = $${i++}`);
        let val = req.body[f];
        if (f === 'confirmado') val = val === null ? null : val ? 1 : 0;
        if (f === 'conviteEnviado') val = val ? 1 : 0;
        values.push(val);
      }
    });
    if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar' });
    values.push(id);
    const { rows } = await pool.query(
      `UPDATE convidados SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, values
    );
    res.json(rowToGuest(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/convidados/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM convidados WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Dados extras ────────────────────────────────────────
app.get('/api/dados/:chave', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT valor FROM dados WHERE chave = $1', [req.params.chave]);
    res.json(rows.length ? JSON.parse(rows[0].valor) : null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dados/:chave', async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO dados (chave,valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor',
      [req.params.chave, JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Confirmação pública ──────────────────────────────────────
app.get('/confirmar/:token', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM convidados WHERE token = $1', [req.params.token]);
    if (!rows.length) return res.send(paginaErro('Link inválido ou expirado.'));
    res.send(paginaConfirmacao(rows[0]));
  } catch (e) { res.send(paginaErro('Erro interno.')); }
});

app.post('/confirmar/:token', async (req, res) => {
  try {
    const { resposta } = req.body;
    const { rows } = await pool.query('SELECT * FROM convidados WHERE token = $1', [req.params.token]);
    if (!rows.length) return res.status(404).send(paginaErro('Token inválido'));
    const confirmado = resposta === 'sim' ? 1 : 0;
    await pool.query(
      'UPDATE convidados SET confirmado = $1, "conviteEnviado" = 1 WHERE token = $2',
      [confirmado, req.params.token]
    );
    res.send(paginaObrigado(rows[0].nome, resposta === 'sim'));
  } catch (e) { res.send(paginaErro('Erro ao salvar resposta.')); }
});

// ── Páginas HTML ─────────────────────────────────────────────
function paginaConfirmacao(guest) {
  const jaRespondeu = guest.confirmado !== null
    ? `<div class="already">${Number(guest.confirmado)===1 ? '✅ Você já confirmou presença!' : '❌ Você já informou que não vai comparecer.'}<br/>Deseja alterar sua resposta?</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>🎮 Convite - Festa do Arthur</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@700;900&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#0a0f1e;font-family:'Nunito',sans-serif;color:#fff;overflow-x:hidden;min-height:100vh;}
#intro{position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(170deg,#0a0f1e 0%,#0055bb 50%,#0a0f1e 100%);}
#intro.hide{opacity:0;pointer-events:none;transition:opacity .8s ease;}
.rings-top{position:absolute;top:0;left:0;width:100%;height:8px;background:repeating-linear-gradient(90deg,#FFD700 0,#FFD700 24px,transparent 24px,transparent 48px);}
.rings-bot{position:absolute;bottom:0;left:0;width:100%;height:8px;background:repeating-linear-gradient(90deg,#FFD700 0,#FFD700 24px,transparent 24px,transparent 48px);}
.particles{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.p{position:absolute;border-radius:50%;animation:pfloat linear infinite;}
@keyframes pfloat{0%{transform:translateY(100vh);opacity:1;}100%{transform:translateY(-120px);opacity:0;}}
@keyframes sonicRun{0%{transform:translateX(-400px);opacity:0;}60%{transform:translateX(8px);opacity:1;}80%{transform:translateX(-4px);}100%{transform:translateX(0);opacity:1;}}
.sonic-char{animation:sonicRun 1s cubic-bezier(.34,1.56,.64,1) .2s both;width:100%;max-width:420px;padding:0 16px;}
@keyframes popIn{from{opacity:0;transform:scale(.6);}to{opacity:1;transform:scale(1);}}
.t1{font-family:'Bebas Neue',cursive;font-size:56px;color:#fff;letter-spacing:4px;text-shadow:0 0 40px #29B6F6,3px 3px 0 #003388;animation:popIn .6s cubic-bezier(.34,1.56,.64,1) .9s both;text-align:center;line-height:1;}
.t2{font-family:'Bebas Neue',cursive;font-size:24px;color:#FFD700;letter-spacing:8px;text-shadow:0 0 20px #FFD700;animation:popIn .5s ease 1.2s both;margin-top:4px;}
.t3{font-size:14px;color:rgba(255,255,255,.5);font-weight:700;animation:popIn .5s ease 1.5s both;margin-top:12px;}
.t4{font-size:18px;font-weight:900;color:#FFD700;animation:popIn .5s ease 1.8s both;margin-top:8px;}
@keyframes btnPulse{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(0,102,204,.5);}50%{transform:scale(1.03);box-shadow:0 0 0 10px rgba(0,102,204,0);}}
.btn-ver{background:linear-gradient(135deg,#0066CC,#004499);color:#fff;border:none;border-radius:50px;padding:16px 44px;font-family:'Nunito',sans-serif;font-weight:900;font-size:18px;cursor:pointer;margin-top:28px;animation:popIn .5s ease 2.1s both,btnPulse 2s ease 2.7s infinite;}
#confirm{display:none;min-height:100vh;background:linear-gradient(170deg,#0a0f1e 0%,#0d1f4a 50%,#0a0f1e 100%);padding:20px 20px 40px;}
.confirm-inner{max-width:420px;margin:0 auto;}
@keyframes cardIn{from{opacity:0;transform:translateY(28px);}to{opacity:1;transform:translateY(0);}}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:24px;margin-bottom:14px;backdrop-filter:blur(12px);animation:cardIn .5s ease both;}
.card:nth-child(2){animation-delay:.1s;}.card:nth-child(3){animation-delay:.2s;}
.badge-top{display:inline-block;background:linear-gradient(135deg,#0066CC,#004499);border-radius:50px;padding:6px 20px;font-family:'Bebas Neue',cursive;font-size:13px;letter-spacing:3px;margin-bottom:14px;}
.main-title{font-family:'Bebas Neue',cursive;font-size:42px;letter-spacing:2px;line-height:1;margin-bottom:4px;}
.arthur{font-family:'Bebas Neue',cursive;font-size:58px;letter-spacing:3px;color:#FFD700;text-shadow:0 0 20px #FFD700;line-height:1;}
.date-pill{display:inline-flex;align-items:center;gap:8px;background:rgba(255,215,0,.12);border:1px solid rgba(255,215,0,.3);border-radius:50px;padding:8px 18px;font-weight:700;font-size:13px;color:#FFD700;margin:12px 0;}
.guest-name{font-size:22px;font-weight:900;color:#fff;margin:14px 0 4px;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0;}
.grid-item{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:14px 10px;text-align:center;}
.gi-icon{font-size:22px;margin-bottom:6px;}
.gi-label{font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:1px;font-weight:700;}
.gi-val{font-size:14px;font-weight:900;margin-top:3px;}
.confirm-q{font-family:'Bebas Neue',cursive;font-size:13px;letter-spacing:3px;color:rgba(255,255,255,.4);margin-bottom:14px;text-align:center;}
.btns{display:flex;gap:12px;}
.btn-sim{flex:1;background:linear-gradient(135deg,#22C55E,#16A34A);color:#fff;border:none;border-radius:16px;padding:18px;font-family:'Nunito',sans-serif;font-size:17px;font-weight:900;cursor:pointer;box-shadow:0 4px 20px rgba(34,197,94,.3);}
.btn-nao{flex:1;background:rgba(255,255,255,.08);color:rgba(255,255,255,.6);border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:18px;font-family:'Nunito',sans-serif;font-size:17px;font-weight:900;cursor:pointer;}
form{flex:1;margin:0;}
.already{background:rgba(255,215,0,.1);border:1px solid rgba(255,215,0,.3);border-radius:14px;padding:14px;margin-bottom:16px;font-size:13px;color:#FFD700;text-align:center;}
</style>
</head>
<body>
<div id="intro">
  <div class="rings-top"></div>
  <div class="rings-bot"></div>
  <div class="particles" id="particles"></div>
  <div class="t1">SONIC<br/>EM AÇÃO</div>
  <div class="t2">EM AÇÃO</div>
  <div class="t3">Festa de Aniversário do Arthur</div>
  <div class="t4">📅 10 de Janeiro de 2027 às 12:30h</div>
  <button class="btn-ver" onclick="showConfirm()">Ver meu convite ➜</button>
  <div style="margin-top:16px;">
    <button id="music-btn" onclick="toggleMusic()" style="background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:50px;padding:8px 20px;font-family:'Nunito',sans-serif;font-size:13px;font-weight:700;cursor:pointer;">🎵 Tocar música</button>
  </div>
</div>

<div id="confirm">
  <div class="confirm-inner">
    <div class="card" style="text-align:center">
      <div class="badge-top">⚡ CONVITE ESPECIAL</div>
      <div class="main-title">Festa de Aniversário</div>
      <div class="arthur">ARTHUR</div>
      <div class="date-pill">📅 10 de Janeiro de 2027 às 12:30h</div>
    </div>
    <div class="card">
      <div class="grid">
        <div class="grid-item"><div class="gi-icon">🎂</div><div class="gi-label">Aniversariante</div><div class="gi-val">Arthur</div></div>
        <div class="grid-item"><div class="gi-icon">🎮</div><div class="gi-label">Tema</div><div class="gi-val">Sonic em Ação</div></div>
        <div class="grid-item"><div class="gi-icon">📅</div><div class="gi-label">Data</div><div class="gi-val">10/01/2027</div></div>
        <div class="grid-item"><div class="gi-icon">⏰</div><div class="gi-label">Horário</div><div class="gi-val">12:30h</div></div>
      </div>
      <a href="https://www.google.com/maps/search/?api=1&query=R.+Jos%C3%A9+Escodro+Sobrinho+61+Residencial+Vale+do+Sol+Indaiatuba+SP" target="_blank" style="display:flex;align-items:center;gap:10px;background:rgba(26,115,232,.15);border:1px solid rgba(26,115,232,.4);border-radius:14px;padding:12px 16px;margin:14px 0;text-decoration:none;color:#fff;">
        <div style="font-size:24px;flex-shrink:0">📍</div>
        <div>
          <div style="font-size:11px;color:rgba(255,255,255,.4);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:2px">Local da Festa</div>
          <div style="font-size:13px;font-weight:700">R. José Escodro Sobrinho, 61 - Res. Vale do Sol, Indaiatuba - SP</div>
          <div style="font-size:11px;color:#1E88E5;margin-top:2px;font-weight:700">📲 Toque para abrir no Maps</div>
        </div>
      </a>
      <div style="background:linear-gradient(135deg,#0066CC,#00AAFF);border-radius:16px;padding:18px 16px;margin-bottom:14px;text-align:center;box-shadow:0 4px 20px rgba(0,102,204,.4);">
        <div style="font-size:36px;margin-bottom:6px">🏊‍♂️💦</div>
        <div style="font-family:'Bebas Neue',cursive;font-size:22px;letter-spacing:2px;color:#fff;margin-bottom:4px;">PISCINA LIBERADA!</div>
        <div style="font-size:14px;color:rgba(255,255,255,.9);font-weight:700;">Traga sua roupa de banho e aproveite! 🌊</div>
        <div style="margin-top:8px;background:rgba(255,255,255,.2);border-radius:10px;padding:8px 12px;font-size:13px;color:#fff;">
          💡 <strong>Não esqueça:</strong> protetor solar, toalha e muita energia! ☀️
        </div>
      </div>
      <div class="guest-name">Olá, ${guest.nome}! 😊</div>
      ${guest.nomes ? `
      <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px 16px;margin:10px 0;text-align:left;">
        <div style="font-size:11px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:6px;">👥 Convidados</div>
        <div style="font-size:14px;font-weight:700;color:#fff;line-height:1.6;">${guest.nomes}</div>
      </div>` : ''}
      <div style="color:rgba(255,255,255,.75);font-size:14px;line-height:1.7;margin-top:4px;">
        Venho aqui te fazer um convite super especial! 🎉<br/>
        Será um dia cheio de alegria, diversão e momentos inesquecíveis,<br/>
        e a sua presença vai deixar tudo ainda mais completo. ✨<br/>
        <strong style="color:#FFD700">Espero você para comemorarmos juntos!</strong>
      </div>
    </div>
    <div class="card">
      ${jaRespondeu}
      <div class="confirm-q">VOCÊ VAI COMPARECER?</div>
      <div class="btns">
        <form method="POST"><input type="hidden" name="resposta" value="sim"/><button type="submit" class="btn-sim">🎉 Sim, vou!</button></form>
        <form method="POST"><input type="hidden" name="resposta" value="nao"/><button type="submit" class="btn-nao">😢 Não vou</button></form>
      </div>
    </div>
    <p style="text-align:center;font-size:11px;color:rgba(255,255,255,.2);margin-top:16px;">⚡ Sonic em Ação — Festa do Arthur 2027</p>
  </div>
</div>

<script>
let audio = null;
let musicOn = false;

function initAudio() {
  if (audio) return;
  audio = new Audio('https://jetta.vgmtreasurechest.com/soundtracks/sonic-1-revisited/joswegvj/01%20Green%20Hill%20Zone%20Act%201.mp3');
  audio.loop = true;
  audio.volume = 0.5;
}

function startMusic() {
  initAudio();
  audio.play().then(() => {
    musicOn = true;
    const btn = document.getElementById('music-btn');
    if (btn) btn.textContent = '🔇 Pausar música';
  }).catch(() => {});
}

function toggleMusic() {
  const btn = document.getElementById('music-btn');
  if (!musicOn) {
    startMusic();
  } else {
    audio.pause();
    musicOn = false;
    if (btn) btn.textContent = '🎵 Tocar música';
  }
}

document.addEventListener('click', function onFirst() {
  startMusic();
  document.removeEventListener('click', onFirst);
}, { once: true });

const pc = document.getElementById('particles');
for(let i=0;i<20;i++){
  const p=document.createElement('div');
  p.className='p';
  const size=2+Math.random()*5;
  p.style.cssText='left:'+Math.random()*100+'%;width:'+size+'px;height:'+size+'px;background:'+(Math.random()>.5?'#0066CC':'#FFD700')+';opacity:'+(0.3+Math.random()*.7)+';animation-duration:'+(3+Math.random()*4)+'s;animation-delay:'+Math.random()*3+'s;';
  pc.appendChild(p);
}
function showConfirm(){
  document.getElementById('intro').classList.add('hide');
  setTimeout(()=>{
    document.getElementById('intro').style.display='none';
    document.getElementById('confirm').style.display='block';
    window.scrollTo(0,0);
  },800);
}
</script>
</body>
</html>`;
}

function paginaObrigado(nome, confirmado) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${confirmado?'Confirmado!':'Ok!'} - Festa do Arthur</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@700;900&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:linear-gradient(170deg,#0a0f1e,#0055bb 50%,#0a0f1e 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:'Nunito',sans-serif;color:#fff;padding:20px;}
.card{background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.15);border-radius:24px;padding:40px 28px;max-width:400px;width:100%;text-align:center;backdrop-filter:blur(10px);}
h1{font-family:'Bebas Neue',cursive;font-size:48px;letter-spacing:2px;margin:16px 0 12px;}
p{font-size:16px;color:rgba(255,255,255,.8);line-height:1.7;}
.rings{height:6px;background:repeating-linear-gradient(90deg,#FFD700 0,#FFD700 22px,transparent 22px,transparent 44px);margin-bottom:24px;border-radius:3px;}
</style>
</head>
<body>
<div class="card">
  <div class="rings"></div>
  <div style="font-size:80px;filter:drop-shadow(0 0 20px ${confirmado?'#22C55E':'#666'})">${confirmado?'🎉':'😢'}</div>
  <h1>${confirmado?'Arrasou!':'Tudo bem!'}</h1>
  <p>${confirmado
    ? `<strong>${nome}</strong>, sua presença foi confirmada!<br/>Te esperamos na festa do Arthur! 🦔⚡🎂`
    : `<strong>${nome}</strong>, sentiremos sua falta!<br/>Obrigado por avisar! 🦔`
  }</p>
  <p style="margin-top:20px;font-size:12px;color:rgba(255,255,255,.3);">Sonic em Ação — 10/01/2027 às 12:30h</p>
</div>
</body>
</html>`;
}

function paginaErro(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Erro</title></head>
<body style="background:#0a1628;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;">
<div><div style="font-size:48px">😕</div><h2 style="margin:16px 0 8px">Link inválido</h2><p style="color:rgba(255,255,255,.6)">${msg}</p></div></body></html>`;
}

// ── Rota de seed (cadastro em massa) ────────────────────────
app.get('/seed-convidados', async (req, res) => {
  const convidados = [
    { nome: "Casa",           grupo: "Família", adultos: 9,  criancas: 1 },
    { nome: "Tia Nice",       grupo: "Família", adultos: 6,  criancas: 2 },
    { nome: "Vó e Tia Vânia", grupo: "Família", adultos: 3,  criancas: 1 },
    { nome: "Tia Amarilsa",   grupo: "Família", adultos: 4,  criancas: 0 },
    { nome: "Tio Cleiton",    grupo: "Família", adultos: 2,  criancas: 0 },
    { nome: "Tio Amauri",     grupo: "Família", adultos: 2,  criancas: 2 },
    { nome: "Thaisi",         grupo: "Família", adultos: 2,  criancas: 1 },
    { nome: "Dani",           grupo: "Família", adultos: 2,  criancas: 1 },
    { nome: "Ilza",           grupo: "Família", adultos: 3,  criancas: 0 },
    { nome: "Carol",          grupo: "Família", adultos: 3,  criancas: 0 },
    { nome: "Geisa",          grupo: "Família", adultos: 2,  criancas: 1 },
    { nome: "Sueli",          grupo: "Família", adultos: 5,  criancas: 0 },
    { nome: "Tia Lídia",      grupo: "Família", adultos: 3,  criancas: 2 },
    { nome: "Ana",            grupo: "Família", adultos: 3,  criancas: 0 },
    { nome: "Sirley",         grupo: "Família", adultos: 4,  criancas: 0 },
    { nome: "Wanda",          grupo: "Família", adultos: 2,  criancas: 1 },
    { nome: "Gabriel",        grupo: "Família", adultos: 2,  criancas: 1 },
    { nome: "Edi",            grupo: "Família", adultos: 2,  criancas: 0 },
    { nome: "Julio",          grupo: "Família", adultos: 2,  criancas: 1 },
    { nome: "Parentes SP",    grupo: "Família", adultos: 3,  criancas: 1 },
    { nome: "Maurício",       grupo: "Família", adultos: 2,  criancas: 2 },
    { nome: "Serviço",        grupo: "Amigos",  adultos: 6,  criancas: 3 },
    { nome: "Denício",        grupo: "Família", adultos: 2,  criancas: 1 },
  ];

  const results = [];
  for (const c of convidados) {
    try {
      const token = require('crypto').randomBytes(8).toString('hex');
      const { rows } = await pool.query(
        'INSERT INTO convidados (nome, grupo, adultos, criancas, telefone, token) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *',
        [c.nome, c.grupo, c.adultos, c.criancas, '', token]
      );
      results.push({ nome: c.nome, status: rows.length ? '✅ cadastrado' : '⚠️ já existia' });
    } catch(e) {
      results.push({ nome: c.nome, status: '❌ erro: ' + e.message });
    }
  }

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <style>body{background:#0a1628;color:#fff;font-family:sans-serif;padding:30px;max-width:500px;margin:0 auto;}
  h2{color:#22C55E;} li{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:14px;}
  a{display:block;margin-top:24px;background:#CC0000;color:#fff;padding:14px;border-radius:12px;text-align:center;text-decoration:none;font-weight:700;}
  </style></head><body>
  <h2>🦔 Cadastro concluído!</h2>
  <ul>${results.map(r=>`<li>${r.nome} — ${r.status}</li>`).join('')}</ul>
  <p style="color:rgba(255,255,255,.5);font-size:12px;margin-top:16px;">Total: 95 pessoas (74 adultos + 21 crianças)</p>
  <a href="/">Abrir o App</a>
  </body></html>`;
  res.send(html);
});

// ── Relatório para o Buffet ─────────────────────────────────
app.get('/relatorio', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM convidados ORDER BY grupo, nome');
    const confirmados = rows.filter(r => Number(r.confirmado) === 1);
    const pendentes = rows.filter(r => r.confirmado === null);
    const recusaram = rows.filter(r => Number(r.confirmado) === 0);

    const totalAdultos = confirmados.reduce((a,r)=>a+r.adultos,0);
    const totalCriancas = confirmados.reduce((a,r)=>a+r.criancas,0);
    const totalGeral = confirmados.reduce((a,r)=>a+r.adultos+r.criancas,0);
    const totalAdultosGeral = rows.reduce((a,r)=>a+r.adultos,0);
    const totalCriancasGeral = rows.reduce((a,r)=>a+r.criancas,0);
    const totalGeralTodos = rows.reduce((a,r)=>a+r.adultos+r.criancas,0);

    const renderGrupo = (lista, titulo, cor) => {
      if (!lista.length) return '';
      const totalA = lista.reduce((a,r)=>a+r.adultos,0);
      const totalC = lista.reduce((a,r)=>a+r.criancas,0);
      return `
        <div class="grupo">
          <div class="grupo-title" style="background:${cor}">${titulo} — ${lista.length} grupos &nbsp;|&nbsp; 👤 ${totalA} adultos &nbsp; 👶 ${totalC} crianças &nbsp; Total: ${totalA+totalC}</div>
          <table>
            <thead><tr>
              <th style="width:18%">Responsável</th>
              <th style="width:35%">👥 Quem vai comparecer</th>
              <th style="width:8%;text-align:center">Adultos</th>
              <th style="width:8%;text-align:center">Crianças</th>
              <th style="width:15%">🎂 Idade(s)</th>
              <th style="width:8%;text-align:center">Total</th>
              <th style="width:8%;text-align:center">Status</th>
            </tr></thead>
            <tbody>
              ${lista.map(r => `
                <tr style="background:${Number(r.confirmado)===1?'#f0fff4':r.confirmado===null?'#fffbf0':'#fff5f5'}">
                  <td><strong>${r.nome}</strong><br/><small style="color:#999">${r.grupo}</small></td>
                  <td style="color:#333;word-break:break-word">${r.nomes||'<span style="color:#bbb">—</span>'}</td>
                  <td style="text-align:center">${r.adultos}</td>
                  <td style="text-align:center">${r.criancas}</td>
                  <td style="color:#e67e22;word-break:break-word">${r.idadeCrianca||'—'}</td>
                  <td style="text-align:center;font-weight:700">${r.adultos+r.criancas}</td>
                  <td style="text-align:center">${Number(r.confirmado)===1?'✅':r.confirmado===null?'⏳':'❌'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    };

    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Relatório Buffet — Festa do Arthur</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f5f5f5;color:#222;padding:20px;}
  .header{background:linear-gradient(135deg,#0066CC,#004499);color:#fff;border-radius:16px;padding:28px 24px;margin-bottom:24px;text-align:center;}
  .header h1{font-size:28px;letter-spacing:1px;margin-bottom:4px;}
  .header p{opacity:.8;font-size:14px;}
  .resumo{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;}
  .card{background:#fff;border-radius:12px;padding:16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.08);}
  .card .num{font-size:36px;font-weight:700;line-height:1;}
  .card .label{font-size:12px;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:1px;}
  .grupo{margin-bottom:24px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);}
  .grupo-title{color:#fff;padding:12px 20px;font-weight:700;font-size:15px;letter-spacing:.5px;}
  table{width:100%;border-collapse:collapse;}
  th{background:#f9f9f9;padding:10px 14px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#888;border-bottom:1px solid #eee;}
  td{padding:12px 14px;border-bottom:1px solid #f0f0f0;font-size:14px;vertical-align:top;}
  tr:last-child td{border-bottom:none;}
  tr:hover td{background:#fafafa;}
  .pendente-warn{background:#fff8e1;border:1px solid #ffc107;border-radius:10px;padding:12px 16px;margin-bottom:24px;font-size:13px;color:#7a5c00;}
  .footer{text-align:center;font-size:12px;color:#aaa;margin-top:24px;padding-top:16px;border-top:1px solid #eee;}
  .btn-print{display:inline-block;background:#0066CC;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin-bottom:20px;cursor:pointer;border:none;font-size:15px;}
  @media print{.btn-print,.no-print{display:none!important;}body{background:#fff;padding:0;}.grupo,.card{box-shadow:none;}}
</style>
</head>
<body>
  <div class="no-print" style="text-align:center;margin-bottom:16px;">
    <button class="btn-print" onclick="window.print()">🖨️ Imprimir / Salvar PDF</button>
  </div>
  <div class="header">
    <h1>🎮 Festa do Arthur — Sonic em Ação</h1>
    <p>📅 10 de Janeiro de 2027 às 12:30h &nbsp;|&nbsp; 📍 R. José Escodro Sobrinho, 61 - Res. Vale do Sol, Indaiatuba</p>
    <p style="margin-top:6px;font-size:13px;opacity:.7">Relatório gerado em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</p>
  </div>

  <div class="resumo">
    <div class="card"><div class="num" style="color:#0066CC">${totalGeralTodos}</div><div class="label">Total Geral</div><div style="font-size:11px;color:#aaa;margin-top:4px">${totalAdultosGeral} adultos · ${totalCriancasGeral} crianças</div></div>
    <div class="card"><div class="num" style="color:#22c55e">${totalGeral}</div><div class="label">✅ Confirmados</div><div style="font-size:11px;color:#aaa;margin-top:4px">${totalAdultos} adultos · ${totalCriancas} crianças</div></div>
    <div class="card"><div class="num" style="color:#f59e0b">${pendentes.length}</div><div class="label">⏳ Aguardando</div></div>
    <div class="card"><div class="num" style="color:#ef4444">${recusaram.length}</div><div class="label">❌ Recusaram</div></div>
  </div>

  ${pendentes.length ? `<div class="pendente-warn">⚠️ <strong>${pendentes.length} grupos</strong> ainda não confirmaram presença. Total estimado se todos confirmarem: <strong>${rows.reduce((a,r)=>a+r.adultos+r.criancas,0)} pessoas</strong>.</div>` : ''}

  ${renderGrupo(rows.filter(r=>r.grupo==='Família'), '👨‍👩‍👧‍👦 Família', '#0066CC')}
  ${renderGrupo(rows.filter(r=>r.grupo==='Amigos'), '🤝 Amigos', '#7C3AED')}
  ${renderGrupo(rows.filter(r=>r.grupo==='Escola'), '🎒 Escola', '#059669')}
  ${renderGrupo(rows.filter(r=>!['Família','Amigos','Escola'].includes(r.grupo)), '📋 Outros', '#64748b')}

  <div class="footer">
    Festa do Arthur · Sonic em Ação · 10/01/2027 · festaarthur.vercel.app
  </div>
</body>
</html>`);
  } catch(e) {
    res.status(500).send('Erro ao gerar relatório: '+e.message);
  }
});

// ── Inicialização ────────────────────────────────────────────
// Condicional: roda servidor local normal, mas no Vercel exporta o app
if (require.main === module) {
  app.listen(PORT, () => console.log(`Festa do Arthur rodando na porta ${PORT}`));
}

module.exports = app;
