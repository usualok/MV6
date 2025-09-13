chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "START_LIKER") {
    console.log("🚀 Liker démarré");
    // Ici tu appelles ton workflow Liker
  }

  if (msg.action === "START_REPLY") {
    console.log("🚀 Auto-Reply démarré");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: "startReply" });
    });
  }
});
// background.js — v2.1 (adaptive planning + logs + SPA-safe)

let currentState = { running:false, tabId:null, sessionId:null };

const sleep = ms => new Promise(r=>setTimeout(r,ms));

function parseHHMM(s){const[hh,mm]=(s||'').split(':').map(x=>parseInt(x,10));return{hh:hh||0,mm:mm||0};}
function inWindow(now, startHHMM, endHHMM){
  const s=parseHHMM(startHHMM), e=parseHHMM(endHHMM);
  const n=now.getHours()*60+now.getMinutes(), sm=s.hh*60+s.mm, em=e.hh*60+e.mm;
  if (sm===em) return true;
  return sm<em ? (n>=sm && n<=em) : (n>=sm || n<=em);
}
function todayKey(d=new Date()){return d.toISOString().slice(0,10);}
function clamp(n,a,b){return Math.max(a,Math.min(b,n));}

async function cfg(){return await chrome.storage.sync.get({
  listUrl:"", likePercentMin:20, likePercentMax:30, minDelayMs:2500, maxDelayMs:6000,
  scrollPauseMinMs:1200, scrollPauseMaxMs:2500, preferRepliesWithLikesUnder:10, maxLikesPerPost:999,
  listMinComments:10, listPrefetchScrollsMin:2, listPrefetchScrollsMax:5, listScanBatchSize:12,
  stepMode:"random", stepMin:1, stepMax:10, stepFixed:3,
  skipProcessedDays:2, skipIfLikedRatioGTE:0.6,
  sessionMinMin:5, sessionMaxMin:30, restMinMin:5, restMaxMin:30,
  autoEnable:false, autoStart:"08:00", autoEnd:"22:00"
});}

/* ---------- Journal ---------- */
async function getDayLog(){
  const k=todayKey();const obj=await chrome.storage.local.get({dayLog:null});
  let log=obj.dayLog; if(!log||log.day!==k) log={day:k,sessions:[],events:[]};
  return log;
}
async function putDayLog(log){await chrome.storage.local.set({dayLog:log});}
async function appendSession(entry){const log=await getDayLog();log.sessions.push(entry);await putDayLog(log);}
async function updateLastSession(patch){const log=await getDayLog();if(log.sessions.length){Object.assign(log.sessions[log.sessions.length-1],patch);}await putDayLog(log);}
async function logEvent(text, sessionId=null){const log=await getDayLog();log.events.push({ts:Date.now(), text, sessionId}); if(log.events.length>400) log.events.splice(0,log.events.length-400); await putDayLog(log);}

/* ---------- Tabs / SPA-safe ---------- */
async function ensureXTab(targetUrl="https://x.com/home"){
  const tabs=await chrome.tabs.query({});
  let tab=tabs.find(t=>t.url && (t.url.startsWith("https://x.com")||t.url.startsWith("https://twitter.com")));
  if(!tab) tab=await chrome.tabs.create({url:targetUrl,active:true});
  else{
    if(tab.url!==targetUrl) tab=await chrome.tabs.update(tab.id,{active:true,url:targetUrl});
    else await chrome.tabs.update(tab.id,{active:true});
  }
  currentState.tabId=tab.id; return tab.id;
}
async function waitTabLoaded(tabId, t=25000){
  const t0=Date.now(); while(Date.now()-t0<t){try{const tab=await chrome.tabs.get(tabId); if(tab.status==='complete') return true;}catch{} await sleep(150);} return false;
}
async function registerCS(){
  try{
    const list=await chrome.scripting.getRegisteredContentScripts();
    if(!list.some(s=>s.id==='xliker-cs'))
      await chrome.scripting.registerContentScripts([{
        id:'xliker-cs', js:['contentScript.js'],
        matches:['https://x.com/*','https://twitter.com/*'], runAt:'document_idle', persistAcrossSessions:true
      }]);
  }catch{}
}
async function pingCS(tabId,timeout=800){
  try{
    const p=chrome.tabs.sendMessage(tabId,{type:'CS_PING'});
    const res=await Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej('timeout'),timeout))]);
    return !!(res&&res.pong);
  }catch{return false;}
}
async function injectCS(tabId){try{await chrome.scripting.executeScript({target:{tabId},files:['contentScript.js']}); await sleep(120);}catch{}}

/* ---------- Planification adaptive ---------- */
function minutes(n){return n*60*1000;}
function nextRestMs(c){return minutes(clamp(Math.floor(Math.random()*(c.restMaxMin-c.restMinMin+1))+c.restMinMin,1,1440));}
function nextSessionMs(c){return minutes(clamp(Math.floor(Math.random()*(c.sessionMaxMin-c.sessionMinMin+1))+c.sessionMinMin,1,1440));}

async function scheduleNextAdaptive() {
  const c=await cfg(); await chrome.alarms.clear('next');
  if(!c.autoEnable) return;
  const now=new Date();
  let ts=Date.now()+nextRestMs(c);

  const inWin=inWindow(now,c.autoStart,c.autoEnd);
  const [sh,sm]=[parseInt(c.autoStart.split(':')[0],10)||0,parseInt(c.autoStart.split(':')[1],10)||0];
  const [eh,em]=[parseInt(c.autoEnd.split(':')[0],10)||0,parseInt(c.autoEnd.split(':')[1],10)||0];

  const todayStart=new Date(now); todayStart.setHours(sh,sm,0,0);
  const todayEnd=new Date(now); todayEnd.setHours(eh,em,0,0);

  if(!inWin || ts>todayEnd.getTime()){
    const d=new Date(todayStart);
    if(inWin && ts>todayEnd.getTime()) d.setDate(d.getDate()+1);
    else if(!inWin && now>=todayStart) d.setDate(d.getDate()+1);
    ts=d.getTime();
  }
  const when = Math.max(Date.now()+1000, ts);
  chrome.alarms.create('next',{when});
  await logEvent(`Prochaine session planifiée à ${new Date(when).toLocaleTimeString()}`);
}

/* ---------- Démarrage / Fin ---------- */
async function startOnTab(tabId, trigger){
  await waitTabLoaded(tabId,25000);
  if(!(await pingCS(tabId))){
    await injectCS(tabId);
    if(!(await pingCS(tabId))){
      await chrome.tabs.reload(tabId,{bypassCache:true});
      await waitTabLoaded(tabId,25000);
      await injectCS(tabId);
      if(!(await pingCS(tabId))) { await logEvent('Échec: content-script introuvable'); return {ok:false,error:'no CS'}; }
    }
  }

  const c=await cfg();
  const sessionMs=nextSessionMs(c);
  const stepConf={ mode:c.stepMode, min:c.stepMin, max:c.stepMax, fixed:c.stepFixed };
  const start = Date.now();
  const sessionId = start; currentState.sessionId=sessionId;

  await chrome.tabs.sendMessage(tabId,{type:'CS_START', deadlineTs: start+sessionMs, stepConf});
  currentState.running=true;
  await appendSession({id:sessionId, startedAt:new Date(start), trigger, ok:true});
  await logEvent(`Session démarrée (${Math.round(sessionMs/60000)} min)`, sessionId);
  return {ok:true};
}

/* ---------- Alarme ---------- */
chrome.alarms.onAlarm.addListener(async a=>{
  if(a.name!=='next') return;
  if(currentState.running) return;
  const c=await cfg(); if(!c.autoEnable) return;
  const target=c.listUrl || 'https://x.com/home';
  const tabId=await ensureXTab(target);
  await startOnTab(tabId,'auto');
});

async function reschedule() { await scheduleNextAdaptive(); }

/* ---------- Lifecycle ---------- */
chrome.runtime.onInstalled.addListener(async()=>{await registerCS(); await reschedule();});
chrome.runtime.onStartup.addListener(async()=>{await registerCS(); await reschedule();});

/* ---------- Messages ---------- */
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse)=>{
  try{
    if(msg?.type==='EXT_CONTROL'){
      if(msg.action==='GET_STATE') return sendResponse({running:currentState.running, tabId:currentState.tabId});
      if(msg.action==='STOP'){ currentState.running=false; await updateLastSession({finishedAt:new Date()}); await scheduleNextAdaptive(); return sendResponse({ok:true}); }
      if(msg.action==='START'){ currentState.running=true; return sendResponse({ok:true}); }
      return sendResponse({ok:true});
    }
    if(msg?.type==='START_WORKFLOW'){
      const c=await cfg(); const target=(msg.listUrl && msg.listUrl.startsWith('http'))?msg.listUrl:(c.listUrl||'https://x.com/home');
      const tabId=await ensureXTab(target); const r=await startOnTab(tabId,'manual'); sendResponse(r); return true;
    }
    if(msg?.type==='RESCHEDULE_ALARM'){ await reschedule(); return sendResponse({ok:true}); }
    if(msg?.type==='CS_STATS'){
      currentState.running=false;
      await updateLastSession({finishedAt:new Date(), likes:msg.stats?.likes??null, posts:msg.stats?.posts??null});
      await logEvent(`Session terminée — likes:${msg.stats?.likes??0}, posts:${msg.stats?.posts??0}`, currentState.sessionId);
      await scheduleNextAdaptive();
      return sendResponse({ok:true});
    }
    if(msg?.type==='LOG_EVENT'){
      await logEvent(msg.text, currentState.sessionId);
      return sendResponse({ok:true});
    }
  }catch(e){ sendResponse?.({ok:false,error:String(e)}); }
  return true;
});
