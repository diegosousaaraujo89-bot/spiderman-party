let data=[
{id:1,nome:"João",confirmado:null},
{id:2,nome:"Maria",confirmado:null}
];

export default function handler(req,res){
 res.status(200).json(data);
}
