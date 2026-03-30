import express from "express";

const app = express();
app.use(express.json());

let convidados = [
  { id: 1, nome: "João", confirmado: null },
  { id: 2, nome: "Maria", confirmado: null }
];

app.get("/convidados", (req, res) => {
  res.json(convidados);
});

app.post("/confirmar", (req, res) => {
  const { id, val } = req.body;

  convidados = convidados.map(g =>
    g.id === id ? { ...g, confirmado: val } : g
  );

  res.json({ ok: true });
});

app.use(express.static("./"));

app.listen(3000, () => console.log("Rodando ??"));