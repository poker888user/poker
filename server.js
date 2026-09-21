const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== 牌型逻辑（和之前一样） ==========
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const RV = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14};

function createDeck(){const d=[];for(const s of SUITS)for(const r of RANKS)d.push({suit:s,rank:r});return d;}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

function evaluateHand(cards){
  const v=cards.map(c=>RV[c.rank]).sort((a,b)=>b-a);
  const s=cards.map(c=>c.suit);
  const flush=s.every(x=>x===s[0]);
  const cnt={};v.forEach(x=>cnt[x]=(cnt[x]||0)+1);
  const g=Object.entries(cnt).map(([k,c])=>({v:+k,c})).sort((a,b)=>b.c-a.c||b.v-a.v);
  const u=[...new Set(v)];
  let st=false,sh=0;
  if(u.length===5){if(u[0]-u[4]===4){st=true;sh=u[0];}if(u[0]===14&&u[1]===5&&u[4]===2){st=true;sh=5;}}
  if(st&&flush)return[8,[sh]];
  if(g[0].c===4)return[7,[g[0].v,g[1].v]];
  if(g[0].c===3&&g[1].c===2)return[6,[g[0].v,g[1].v]];
  if(flush)return[5,v];
  if(st)return[4,[sh]];
  if(g[0].c===3)return[3,[g[0].v,...g.slice(1).map(x=>x.v)]];
  if(g[0].c===2&&g[1].c===2)return[2,[g[0].v,g[1].v,g[2].v]];
  if(g[0].c===2)return[1,[g[0].v,...g.slice(1).map(x=>x.v)]];
  return[0,v];
}

function compareHands(a,b){
  const[ra,va]=evaluateHand(a),[rb,vb]=evaluateHand(b);
  if(ra!==rb)return ra-rb;
  for(let i=0;i<Math.max(va.length,vb.length);i++)
    if((va[i]||0)!==(vb[i]||0))return(va[i]||0)-(vb[i]||0);
  return 0;
}

function combos(arr,k){
  if(k===0)return[[]];
  if(arr.length<k)return[];
  const[f,...r]=arr;
  return[...combos(r,k-1).map(c=>[f,...c]),...combos(r,k)];
}
function bestHand(seven){
  let best=null;
  for(const c of combos(seven,5))if(!best||compareHands(c,best)>0)best=c;
  return best;
}

const STAGES=['preflop','flop','turn','river','showdown'];

class Room{
  constructor(id){
    this.id=id;this.players=[];this.pot=0;this.community=[];
    this.deck=[];this.stage='waiting';this.currentBet=0;
    this.minRaise=10;this.dealerIndex=0;this.currentIndex=0;
    this.acted=new Set();this.handOver=false;this.showdownResult=null;
  }
  addPlayer(id,name){
    if(this.players.length>=8)return false;
    if(this.players.find(p=>p.id===id))return true;
    this.players.push({id,name,chips:1000,cards:[],bet:0,folded:false,allIn:false});
    return true;
  }
  startHand(){
    const active=this.players.filter(p=>p.chips>0);
    if(active.length<2)return{error:'至少需要2名有筹码的玩家'};
    this.deck=shuffle(createDeck());
    this.community=[];this.pot=0;this.currentBet=0;this.minRaise=10;
    this.acted=new Set();this.handOver=false;this.showdownResult=null;
    for(const p of this.players){
      p.cards=[this.deck.pop(),this.deck.pop()];p.bet=0;
      p.folded=p.chips<=0;p.allIn=false;
    }
    this.stage='preflop';
    const n=this.players.length;
    this.dealerIndex=(this.dealerIndex+1)%n;
    const sb=(this.dealerIndex+1)%n,bb=(this.dealerIndex+2)%n;
    this._bet(this.players[sb],5);
    this._bet(this.players[bb],10);
    this.currentBet=10;
    this.currentIndex=(this.dealerIndex+3)%n;
    return{ok:true};
  }
  _bet(p,amt){
    const a=Math.min(amt,p.chips);p.chips-=a;p.bet+=a;this.pot+=a;
    if(p.chips===0)p.allIn=true;return a;
  }
  act(pid,action,amount=0){
    const idx=this.players.findIndex(p=>p.id===pid);
    if(idx!==this.currentIndex)return{error:'还没轮到你'};
    const p=this.players[idx];
    if(p.folded||p.allIn)return{error:'你不能行动'};
    const toCall=this.currentBet-p.bet;
    if(action==='fold')p.folded=true;
    else if(action==='check'){if(toCall>0)return{error:'需要跟注'};}
    else if(action==='call')this._bet(p,toCall);
    else if(action==='raise'){
      const total=Math.max(amount,this.currentBet+this.minRaise);
      const add=total-p.bet;
      if(add>p.chips)return{error:'筹码不足'};
      this._bet(p,add);this.minRaise=total-this.currentBet;
      this.currentBet=total;this.acted.clear();
    }else if(action==='allin'){
      const add=p.chips;this._bet(p,add);
      if(p.bet>this.currentBet){this.minRaise=p.bet-this.currentBet;this.currentBet=p.bet;this.acted.clear();}
    }
    this.acted.add(pid);
    return this._nextTurn();
  }
  _nextTurn(){
    const n=this.players.length;
    const active=this.players.filter(p=>!p.folded);
    if(active.length<=1)return this._awardLast();
    for(let i=1;i<=n;i++){
      const ni=(this.currentIndex+i)%n;
      const np=this.players[ni];
      if(np.folded||np.allIn)continue;
      if(this.acted.has(np.id)&&np.bet===this.currentBet)return this._nextStage();
      this.currentIndex=ni;return{ok:true};
    }
    return this._nextStage();
  }
  _awardLast(){
    const w=this.players.find(p=>!p.folded);
    w.chips+=this.pot;this.handOver=true;
    this.showdownResult={winners:[{id:w.id,name:w.name,cards:w.cards}],pot:this.pot,community:[...this.community]};
    this.pot=0;this.stage='showdown';
    return{ok:true,showdown:this.showdownResult};
  }
  _nextStage(){
    for(const p of this.players)p.bet=0;
    this.currentBet=0;this.minRaise=10;this.acted.clear();
    const si=STAGES.indexOf(this.stage);
    this.stage=STAGES[si+1];
    if(this.stage==='flop'){this.deck.pop();this.community.push(this.deck.pop(),this.deck.pop(),this.deck.pop());}
    else if(this.stage==='turn'||this.stage==='river'){this.deck.pop();this.community.push(this.deck.pop());}
    else if(this.stage==='showdown')return this._showdown();
    this.currentIndex=(this.dealerIndex+1)%this.players.length;
    let guard=0;
    while((this.players[this.currentIndex].folded||this.players[this.currentIndex].allIn)&&guard++<10)
      this.currentIndex=(this.currentIndex+1)%this.players.length;
    return{ok:true};
  }
  _showdown(){
    const active=this.players.filter(p=>!p.folded);
    let winners=[],best=null;
    for(const p of active){
      const h=bestHand([...p.cards,...this.community]);
      if(!best||compareHands(h,best)>0){best=h;winners=[p];}
      else if(compareHands(h,best)===0)winners.push(p);
    }
    const share=Math.floor(this.pot/winners.length);
    winners.forEach(w=>w.chips+=share);
    const rem=this.pot-share*winners.length;
    if(rem>0)winners[0].chips+=rem;
    this.handOver=true;
    this.showdownResult={winners:winners.map(w=>({id:w.id,name:w.name,cards:w.cards})),pot:this.pot,community:[...this.community]};
    this.pot=0;
    return{ok:true,showdown:this.showdownResult};
  }
  getStateFor(pid){
    return{
      roomId:this.id,stage:this.stage,pot:this.pot,community:this.community,
      currentBet:this.currentBet,currentIndex:this.currentIndex,
      dealerIndex:this.dealerIndex,handOver:this.handOver,
      showdownResult:this.showdownResult,
      players:this.players.map(p=>({
        id:p.id,name:p.name,chips:p.chips,bet:p.bet,folded:p.folded,allIn:p.allIn,
        cards:(p.id===pid||this.stage==='showdown')?p.cards:p.cards.map(()=>({hidden:true}))
      }))
    };
  }
}

// ========== HTTP 接口（替代 WebSocket） ==========
const rooms={};
const users={};

app.post('/api/login',(req,res)=>{
  const {name,password}=req.body;
  if(!name)return res.json({error:'请输入昵称'});
  if(!users[name])users[name]={password,chips:1000};
  else if(users[name].password!==password)return res.json({error:'密码错误'});
  res.json({ok:true,chips:users[name].chips});
});

app.post('/api/join',(req,res)=>{
  const {name,roomId}=req.body;
  if(!name)return res.json({error:'请先登录'});
  if(!rooms[roomId])rooms[roomId]=new Room(roomId);
  const r=rooms[roomId];
  r.addPlayer(name,name);
  const p=r.players.find(x=>x.id===name);
  p.chips=users[name]?.chips??1000;
  res.json({ok:true});
});

app.get('/api/state',(req,res)=>{
  const {name,roomId}=req.query;
  if(!rooms[roomId]||!name)return res.json({error:'房间不存在'});
  res.json(rooms[roomId].getStateFor(name));
});

app.post('/api/start',(req,res)=>{
  const {roomId}=req.body;
  if(!rooms[roomId])return res.json({error:'房间不存在'});
  const r=rooms[roomId].startHand();
  if(r.error)return res.json({error:r.error});
  res.json({ok:true});
});

app.post('/api/action',(req,res)=>{
  const {name,roomId,action,amount}=req.body;
  if(!rooms[roomId]||!name)return res.json({error:'房间不存在'});
  const r=rooms[roomId].act(name,action,amount);
  if(r.error)return res.json({error:r.error});
  for(const p of rooms[roomId].players)
    if(users[p.id])users[p.id].chips=p.chips;
  res.json({ok:true,showdown:r.showdown});
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log('运行在 '+PORT));
