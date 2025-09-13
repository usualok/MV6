document.getElementById("startLiker").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "START_LIKER" });
});

document.getElementById("startReply").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "START_REPLY" });
});
const $ = id=>document.getElementById(id);

function fmt(t){const d=new Date(t);return d.toLocaleTimeString();}
async function readCfg(){return await chrome.storage.sync.get({autoEnable:false,autoStart:"08:00",autoEnd:"22:00"});}
async function readLog(){const o=await chrome.storage.local.get({dayLog:null});return o.dayLog;}

async function refresh(){
  $('now').textContent=new Date().toLocaleTimeString();
  try{
    const st=await chrome.runtime.sendMessage({type:'EXT_CONTROL',action:'GET_STATE'});
    $('state').textContent=st?.running?'en cours':'prêt'; $('state').className=st?.running?'ok':'';
  }catch{ $('state').textContent='service indisponible'; $('state').className='err'; }

  const cfg=await readCfg(); $('auto').textContent=cfg.autoEnable?'Activé':'Désactivé'; $('auto').className='pill '+(cfg.autoEnable?'ok':'');
  $('win').textContent=`${cfg.autoStart} → ${cfg.autoEnd}`;

  try{
    const alarms = await chrome.alarms.getAll();
    const next = alarms.find(a=>a.name==='next');
    $('next').textContent = next ? `Prochaine session : ${fmt(next.scheduledTime)}` : 'Prochaine session : —';
  }catch{ $('next').textContent='Prochaine session : —'; }

  const log = await readLog();
  const runs = log?.sessions||[];
  $('runs').innerHTML='';
  runs.slice(-12).reverse().forEach(s=>{
    const li=document.createElement('li');
    li.textContent = `${fmt(s.startedAt)} — ${s.finishedAt?fmt(s.finishedAt):'…'} — likes:${s.likes??0} posts:${s.posts??0}`;
    $('runs').appendChild(li);
  });

  const ev = log?.events||[];
  $('log').innerHTML='';
  ev.slice(-40).reverse().forEach(e=>{
    const li=document.createElement('li');
    li.textContent = `${fmt(e.ts)} — ${e.text}`;
    $('log').appendChild(li);
  });
}

document.addEventListener('DOMContentLoaded', ()=>{
  $('btnStart').onclick=async()=>{ try{ await chrome.runtime.sendMessage({type:'START_WORKFLOW'});}catch{}; setTimeout(refresh,800); };
  $('btnStop').onclick=async()=>{ try{ await chrome.runtime.sendMessage({type:'EXT_CONTROL',action:'STOP'});}catch{}; setTimeout(refresh,300); };
  $('lnkOptions').onclick=(e)=>{e.preventDefault(); chrome.runtime.openOptionsPage();};
  refresh(); setInterval(()=>{$('now').textContent=new Date().toLocaleTimeString();},1000);
  setInterval(refresh,3500);
});
