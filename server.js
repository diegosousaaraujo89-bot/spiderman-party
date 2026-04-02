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
    const { nome, grupo = 'Amigos', adultos = 1, criancas = 0, telefone = '' } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
    const token = gerarToken();
    const { rows } = await pool.query(
      'INSERT INTO convidados (nome, grupo, adultos, criancas, telefone, token) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [nome, grupo, adultos, criancas, telefone, token]
    );
    res.json(rowToGuest(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/convidados/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['nome','grupo','adultos','criancas','telefone','confirmado','conviteEnviado'];
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
<title>Você foi convidado! 🕷️</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@400;700;900&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#0a0a0a;font-family:'Nunito',sans-serif;color:#fff;overflow-x:hidden;min-height:100vh;}

/* ── Intro animada ── */
#intro{position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0a0a0a;transition:opacity .8s ease;}
#intro.hide{opacity:0;pointer-events:none;}

/* Teia de aranha SVG animada */
.web-container{position:absolute;inset:0;overflow:hidden;}
.web-container svg{width:100%;height:100%;opacity:.18;}

/* Web lines animadas */
@keyframes webDraw{from{stroke-dashoffset:800;}to{stroke-dashoffset:0;}}
.web-line{stroke:#CC0000;stroke-width:1;fill:none;stroke-dasharray:800;animation:webDraw 2s ease forwards;}
.web-line:nth-child(2){animation-delay:.2s;}
.web-line:nth-child(3){animation-delay:.4s;}
.web-line:nth-child(4){animation-delay:.6s;}
.web-line:nth-child(5){animation-delay:.3s;}
.web-line:nth-child(6){animation-delay:.5s;}
.web-line:nth-child(7){animation-delay:.1s;}
.web-line:nth-child(8){animation-delay:.7s;}

/* Partículas vermelhas */
.particles{position:absolute;inset:0;pointer-events:none;}
.particle{position:absolute;width:4px;height:4px;border-radius:50%;background:#CC0000;animation:float linear infinite;}
@keyframes float{0%{transform:translateY(100vh) rotate(0deg);opacity:1;}100%{transform:translateY(-100px) rotate(720deg);opacity:0;}}

/* Aranha descendo */
@keyframes spiderDrop{0%{transform:translateY(-120px);opacity:0;}60%{transform:translateY(10px);opacity:1;}80%{transform:translateY(-8px);}100%{transform:translateY(0);opacity:1;}}
.spider-drop{animation:spiderDrop 1s cubic-bezier(.34,1.56,.64,1) .3s both;font-size:80px;position:relative;z-index:2;filter:drop-shadow(0 0 20px #CC0000);}

/* Fio da aranha */
.spider-thread{width:2px;height:80px;background:linear-gradient(to bottom,transparent,rgba(204,0,0,.6));margin:0 auto;animation:threadFade 1s ease .3s both;}
@keyframes threadFade{from{opacity:0;height:0;}to{opacity:1;height:80px;}}

@keyframes titleReveal{from{opacity:0;transform:scale(.6) translateY(20px);}to{opacity:1;transform:scale(1) translateY(0);}}
.intro-title{font-family:'Bebas Neue',cursive;font-size:52px;letter-spacing:4px;color:#fff;text-shadow:0 0 30px #CC0000,3px 3px 0 #800000;animation:titleReveal .6s cubic-bezier(.34,1.56,.64,1) 1.1s both;text-align:center;line-height:1;}
.intro-sub{font-family:'Bebas Neue',cursive;font-size:24px;letter-spacing:8px;color:#CC0000;animation:titleReveal .6s ease 1.4s both;margin-top:4px;}
.intro-name{font-size:20px;font-weight:900;color:#FFD700;animation:titleReveal .6s ease 1.7s both;margin-top:12px;}

@keyframes btnPulse{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(204,0,0,.4);}50%{transform:scale(1.03);box-shadow:0 0 0 10px rgba(204,0,0,0);}}
.intro-btn{background:linear-gradient(135deg,#CC0000,#800000);color:#fff;border:none;border-radius:50px;padding:16px 40px;font-family:'Nunito',sans-serif;font-weight:900;font-size:18px;cursor:pointer;margin-top:32px;animation:titleReveal .6s ease 2s both, btnPulse 2s ease 2.6s infinite;letter-spacing:.5px;}

/* ── Página de confirmação ── */
#confirm{display:none;min-height:100vh;position:relative;padding:24px 20px 40px;}

/* Fundo com teias */
.bg-web{position:fixed;inset:0;z-index:0;overflow:hidden;}
.bg-web::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 20% 0%,rgba(204,0,0,.35) 0%,transparent 60%),radial-gradient(ellipse at 80% 100%,rgba(10,22,40,.8) 0%,transparent 60%),linear-gradient(170deg,#1a0000 0%,#0a0a14 50%,#0a1628 100%);}

.content{position:relative;z-index:1;max-width:420px;margin:0 auto;}

@keyframes cardIn{from{opacity:0;transform:translateY(30px);}to{opacity:1;transform:translateY(0);}}
.card{background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.12);border-radius:24px;padding:28px 24px;backdrop-filter:blur(16px);animation:cardIn .6s ease both;}
.card:nth-child(2){animation-delay:.15s;}
.card:nth-child(3){animation-delay:.3s;}

.badge{display:inline-block;background:linear-gradient(135deg,#CC0000,#800000);border-radius:50px;padding:6px 18px;font-family:'Bebas Neue',cursive;font-size:13px;letter-spacing:3px;margin-bottom:16px;}
h1{font-family:'Bebas Neue',cursive;font-size:38px;letter-spacing:2px;line-height:1;margin-bottom:4px;text-shadow:2px 2px 0 #800000;}
.arthur{font-family:'Bebas Neue',cursive;font-size:52px;letter-spacing:3px;color:#CC0000;line-height:1;text-shadow:3px 3px 0 #500000;}
.date-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(255,215,0,.12);border:1px solid rgba(255,215,0,.3);border-radius:50px;padding:8px 18px;font-weight:700;font-size:13px;color:#FFD700;margin:12px 0;}
.guest-name{font-size:24px;font-weight:900;margin:16px 0 4px;}
.guest-sub{font-size:13px;color:rgba(255,255,255,.5);}

.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:20px 0;}
.info-item{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:14px 12px;text-align:center;}
.info-icon{font-size:24px;margin-bottom:6px;}
.info-label{font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:1px;font-weight:700;}
.info-value{font-size:14px;font-weight:900;margin-top:2px;}

.confirm-label{font-family:'Bebas Neue',cursive;font-size:14px;letter-spacing:3px;color:rgba(255,255,255,.4);margin-bottom:14px;text-align:center;}
.btns{display:flex;gap:12px;}
.btn-sim{flex:1;background:linear-gradient(135deg,#22C55E,#16A34A);color:#fff;border:none;border-radius:16px;padding:18px;font-family:'Nunito',sans-serif;font-size:17px;font-weight:900;cursor:pointer;transition:transform .15s,box-shadow .15s;box-shadow:0 4px 20px rgba(34,197,94,.3);}
.btn-sim:active{transform:scale(.95);}
.btn-nao{flex:1;background:rgba(255,255,255,.08);color:rgba(255,255,255,.6);border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:18px;font-family:'Nunito',sans-serif;font-size:17px;font-weight:900;cursor:pointer;transition:transform .15s;}
.btn-nao:active{transform:scale(.95);}
form{flex:1;margin:0;}

.already{background:rgba(255,215,0,.1);border:1px solid rgba(255,215,0,.3);border-radius:14px;padding:14px;margin-bottom:16px;font-size:13px;color:#FFD700;text-align:center;}
</style>
</head>
<body>

<!-- ══ INTRO ANIMADA ══ -->
<div id="intro">
  <div class="web-container">
    <svg viewBox="0 0 400 800" preserveAspectRatio="xMidYMid slice">
      <!-- Raios da teia -->
      <line class="web-line" x1="200" y1="0" x2="0" y2="400"/>
      <line class="web-line" x1="200" y1="0" x2="400" y2="400"/>
      <line class="web-line" x1="200" y1="0" x2="200" y2="800"/>
      <line class="web-line" x1="200" y1="0" x2="50" y2="700"/>
      <line class="web-line" x1="200" y1="0" x2="350" y2="700"/>
      <line class="web-line" x1="200" y1="0" x2="0" y2="200"/>
      <line class="web-line" x1="200" y1="0" x2="400" y2="200"/>
      <!-- Arcos da teia -->
      <path class="web-line" d="M 60,180 Q 200,140 340,180"/>
      <path class="web-line" d="M 30,320 Q 200,260 370,320"/>
      <path class="web-line" d="M 10,460 Q 200,380 390,460"/>
      <path class="web-line" d="M 0,600 Q 200,500 400,600"/>
    </svg>
  </div>
  <div class="particles" id="particles"></div>
  <div class="spider-thread"></div>
  <div class="spider-drop">🕷️</div>
  <div class="intro-title">HOMEM ARANHA<br/>EM AÇÃO</div>
  <div class="intro-sub">Festa do Arthur</div>
  <div class="intro-name">Olá, ${guest.nome}! Você foi convidado(a)! 🎉</div>
  <button class="intro-btn" onclick="showConfirm()">Ver meu convite ➜</button>
</div>

<!-- ══ CONFIRMAÇÃO ══ -->
<div id="confirm">
  <div class="bg-web"></div>
  <div class="content">
    <div style="text-align:center;padding:24px 0 20px;">
      <div style="font-size:56px;filter:drop-shadow(0 0 16px #CC0000)">🕷️</div>
    </div>

    <div class="card" style="text-align:center;margin-bottom:14px;">
      <div class="badge">🎂 CONVITE ESPECIAL</div>
      <h1>Festa de Aniversário</h1>
      <div class="arthur">ARTHUR</div>
      <div class="date-badge">📅 09 de Janeiro de 2027</div>
    </div>

    <div class="card" style="margin-bottom:14px;">
      <div class="info-grid">
        <div class="info-item">
          <div class="info-icon">🎂</div>
          <div class="info-label">Aniversariante</div>
          <div class="info-value">Arthur</div>
        </div>
        <div class="info-item">
          <div class="info-icon">🕷️</div>
          <div class="info-label">Tema</div>
          <div class="info-value">Homem Aranha</div>
        </div>
        <div class="info-item">
          <div class="info-icon">📅</div>
          <div class="info-label">Data</div>
          <div class="info-value">09/01/2027</div>
        </div>
        <div class="info-item">
          <div class="info-icon">🎉</div>
          <div class="info-label">Convidado(a)</div>
          <div class="info-value" style="color:#FFD700">${guest.nome}</div>
        </div>
      </div>
    </div>

    <div class="card">
      ${jaRespondeu}
      <div class="confirm-label">Você vai comparecer?</div>
      <div class="btns">
        <form method="POST"><input type="hidden" name="resposta" value="sim"/>
          <button type="submit" class="btn-sim">🎉 Sim, vou!</button>
        </form>
        <form method="POST"><input type="hidden" name="resposta" value="nao"/>
          <button type="submit" class="btn-nao">😢 Não vou</button>
        </form>
      </div>
    </div>

    <p style="text-align:center;font-size:11px;color:rgba(255,255,255,.2);margin-top:20px;">🕸️ Festa do Arthur 2027</p>
  </div>
</div>

<script>
// Gera partículas flutuantes
const pc = document.getElementById('particles');
for(let i=0;i<20;i++){
  const p = document.createElement('div');
  p.className = 'particle';
  p.style.cssText = 'left:'+Math.random()*100+'%;animation-duration:'+(3+Math.random()*4)+'s;animation-delay:'+Math.random()*3+'s;width:'+(2+Math.random()*4)+'px;height:'+(2+Math.random()*4)+'px;background:'+(Math.random()>.5?'#CC0000':'#FFD700')+';opacity:'+(0.3+Math.random()*.7)+';';
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
<html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Obrigado! - Festa do Arthur</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@700;900&display=swap" rel="stylesheet"/>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{background:linear-gradient(170deg,#800000,#CC0000 40%,#0a1628 80%);min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:'Nunito',sans-serif;color:#fff;padding:20px;}.card{background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.15);border-radius:24px;padding:36px 28px;max-width:400px;width:100%;text-align:center;backdrop-filter:blur(10px);}h1{font-family:'Bebas Neue',cursive;font-size:40px;letter-spacing:2px;margin:16px 0 8px;}</style>
</head><body><div class="card">
  <div style="font-size:72px">${confirmado ? '🎉' : '😢'}</div>
  <h1>${confirmado ? 'Ótimo!' : 'Tudo bem!'}</h1>
  <p style="font-size:15px;color:rgba(255,255,255,.8);line-height:1.6;">${confirmado ? `<strong>${nome}</strong>, sua presença foi confirmada!<br/>Te esperamos na festa do Arthur! 🕷️🎂` : `<strong>${nome}</strong>, sentiremos sua falta.<br/>Obrigado por avisar!`}</p>
  <p style="margin-top:24px;font-size:12px;color:rgba(255,255,255,.4);">Você já pode fechar esta página.</p>
</div></body></html>`;
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
  <h2>🕷️ Cadastro concluído!</h2>
  <ul>${results.map(r=>`<li>${r.nome} — ${r.status}</li>`).join('')}</ul>
  <p style="color:rgba(255,255,255,.5);font-size:12px;margin-top:16px;">Total: 95 pessoas (74 adultos + 21 crianças)</p>
  <a href="/">Abrir o App</a>
  </body></html>`;
  res.send(html);
});

app.listen(PORT, () => console.log(`Festa do Arthur rodando na porta ${PORT}`));
