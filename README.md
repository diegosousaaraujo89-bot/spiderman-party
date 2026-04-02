# 🕷️ Festa Homem Aranha em Ação

Gerenciador de festa com confirmação automática via WhatsApp.

## Como publicar no Render

### 1. Subir para o GitHub
```bash
git init
git add .
git commit -m "Festa do Arthur - Homem Aranha"
git remote add origin https://github.com/SEU_USUARIO/festa-aranha.git
git push -u origin main
```

### 2. Criar o serviço no Render
1. Acesse [render.com](https://render.com) → **New → Web Service**
2. Conecte seu repositório GitHub
3. Configure:
   - **Name:** festa-aranha
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Clique em **Create Web Service**

### 3. Pronto!
- O app fica em: `https://festa-aranha.onrender.com`
- Os convidados confirmam em: `https://festa-aranha.onrender.com/confirmar/TOKEN`
- O app atualiza automaticamente a cada 30 segundos

## Como funciona
- Ao clicar em ✉️ no convidado e enviar pelo WhatsApp, a mensagem já inclui um **link único de confirmação**
- A pessoa clica no link, vê a página do Homem Aranha e confirma com um botão
- O app atualiza automaticamente na próxima sincronização (até 30s)

## Arquivos
- `server.js` — Backend Express + SQLite
- `index.html` — App React (frontend)
- `package.json` — Dependências Node
