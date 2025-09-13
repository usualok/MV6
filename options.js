// options.js — v2.0 (sessions au temps + pas aléatoire/fixe)
const defaults = {
  listUrl: "",

  likePercentMin: 20, likePercentMax: 30,
  minDelayMs: 2500, maxDelayMs: 6000,
  scrollPauseMinMs: 1200, scrollPauseMaxMs: 2500,
  preferRepliesWithLikesUnder: 10,
  maxLikesPerPost: 999,

  listMinComments: 10, listPrefetchScrollsMin: 2, listPrefetchScrollsMax: 5, listScanBatchSize: 12,

  stepMode: "random", stepMin: 1, stepMax: 10, stepFixed: 3,

  skipProcessedDays: 2, skipIfLikedRatioGTE: 0.6,

  sessionMinMin: 5, sessionMaxMin: 30,
  restMinMin: 5, restMaxMin: 30,

  autoEnable: false, autoStart: "08:00", autoEnd: "22:00"
};

const $ = id => document.getElementById(id);
const setVal = (id,v)=>{const el=$(id); if(el) el.value=v;};
const setChk = (id,v)=>{const el=$(id); if(el) el.checked=!!v;};
const getNum = (id,fb)=>{const el=$(id); if(!el) return fb; const n=el.type==="number"?el.valueAsNumber:parseFloat(el.value); return Number.isFinite(n)?n:fb;};
const getStr = (id,fb)=>{const el=$(id); return el?(el.value??fb):fb;};
const getChk = (id,fb)=>{const el=$(id); return el?!!el.checked:fb;};
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
function ok(msg){const s=$('status'); s.textContent=msg; s.style.color='#0a0'; setTimeout(()=>s.textContent='',2500);}
function ko(msg){const s=$('status'); s.textContent=msg; s.style.color='#c00'; setTimeout(()=>s.textContent='',3500);}

async function load() {
  const cfg = await chrome.storage.sync.get(defaults);
  for (const k of Object.keys(defaults)) {
    if ($(k)?.type === 'checkbox') setChk(k, cfg[k]); else setVal(k, cfg[k]);
  }
}

async function save() {
  const likePercentMin = clamp(getNum('likePercentMin',20),0,100);
  const likePercentMax = clamp(getNum('likePercentMax',30),0,100);
  if (likePercentMin>likePercentMax) return ko('Like % min > max');

  const listPrefetchScrollsMin = clamp(getNum('listPrefetchScrollsMin',2),0,20);
  const listPrefetchScrollsMax = clamp(getNum('listPrefetchScrollsMax',5),listPrefetchScrollsMin,20);

  const payload = {
    listUrl: getStr('listUrl','').trim(),

    likePercentMin, likePercentMax,
    minDelayMs: clamp(getNum('minDelayMs',2500),200,120000),
    maxDelayMs: clamp(getNum('maxDelayMs',6000),200,180000),
    scrollPauseMinMs: clamp(getNum('scrollPauseMinMs',1200),100,60000),
    scrollPauseMaxMs: clamp(getNum('scrollPauseMaxMs',2500),100,120000),
    preferRepliesWithLikesUnder: clamp(getNum('preferRepliesWithLikesUnder',10),0,100),
    maxLikesPerPost: clamp(getNum('maxLikesPerPost',999),0,1000),

    listMinComments: clamp(getNum('listMinComments',10),0,500),
    listPrefetchScrollsMin, listPrefetchScrollsMax,
    listScanBatchSize: clamp(getNum('listScanBatchSize',12),5,50),

    stepMode: getStr('stepMode','random'),
    stepMin: clamp(getNum('stepMin',1),1,50),
    stepMax: clamp(getNum('stepMax',10),1,50),
    stepFixed: clamp(getNum('stepFixed',3),1,50),

    skipProcessedDays: clamp(getNum('skipProcessedDays',2),0,30),
    skipIfLikedRatioGTE: Math.max(0,Math.min(1,parseFloat(getStr('skipIfLikedRatioGTE','0.6'))||0.6)),

    sessionMinMin: clamp(getNum('sessionMinMin',5),1,240),
    sessionMaxMin: clamp(getNum('sessionMaxMin',30),1,240),
    restMinMin: clamp(getNum('restMinMin',5),1,240),
    restMaxMin: clamp(getNum('restMaxMin',30),1,240),

    autoEnable: getChk('autoEnable',false),
    autoStart: getStr('autoStart','08:00') || '08:00',
    autoEnd: getStr('autoEnd','22:00') || '22:00'
  };

  await chrome.storage.sync.set(payload);
  try { await chrome.runtime.sendMessage({ type:'RESCHEDULE_ALARM' }); } catch {}
  ok('Sauvegardé ✓');
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('saveBtn').addEventListener('click', e => { e.preventDefault(); save(); });
});
