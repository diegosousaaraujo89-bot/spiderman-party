let data=[
{id:1,nome:"João",confirmado:null},
{id:2,nome:"Maria",confirmado:null}
];

export default function handler(req,res){
 const {id,val}=JSON.parse(req.body);
 data=data.map(g=>g.id===id?{...g,confirmado:val}:g);
 res.status(200).json({ok:true});
}
