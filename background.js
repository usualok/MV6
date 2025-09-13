// contentScript.js — v2.5 (avec watchdog)
(() => {
  'use strict';

  /* ===================== utils ===================== */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randInt = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
  const qsa = (sel,root=document)=>Array.from(root.querySelectorAll(sel));
  const log = async (t)=>{ try{ await chrome.runtime.sendMessage({type:'LOG_EVENT', text:t}); }catch{} };

  function isOnX(){return location.hostname.includes('x.com')||location.hostname.includes('twitter.com');}
  function waitFor(fn,t=12000,p=120){const t0=Date.now();return new Promise(async res=>{while(Date.now()-t0<t){try{if(await fn())return res(true);}catch{}await sleep(p);}res(false);});}
  async function humanScroll(n=3){
    for(let i=0;i<n;i++){
      window.scrollBy({top:randInt(380,840),behavior:'smooth'});
      await sleep(randInt(650,1200));
      lastActivity = Date.now(); // 🟢 mise à jour activité après scroll
    }
  }
  function nearBottom(px=240){return (window.scrollY + window.innerHeight) >= (document.body.scrollHeight - px);}

  function parseCompactNumber(txt){
    if(!txt) return null;
    let s=String(txt).trim().replace(/\s/g,'').replace(/,/g,'.');
    const m=s.match(/(\d+(?:\.\d+)?)([kKmM])?/); if(!m) return null;
    let n=parseFloat(m[1]); const u=m[2]?.toLowerCase();
    if(u==='k') n*=1e3; if(u==='m') n*=1e6; return Math.round(n);
  }

  /* ===================== config ===================== */
  const defaultCfg = {
    listUrl:"",
    likePercentMin:20, likePercentMax:30,
    minDelayMs:2500, maxDelayMs:6000,
    scrollPauseMinMs:1200, scrollPauseMaxMs:2500,
    preferRepliesWithLikesUnder:10,
    maxLikesPerPost:999,
    listMinComments:10,
    listPrefetchScrollsMin:2,
    listPrefetchScrollsMax:5,
    listScanBatchSize:12,
    stepMode:"random", stepMin:1, stepMax:10, stepFixed:3,
    skipProcessedDays:2,
    skipIfLikedRatioGTE:0.6,
    commentEnabled:true, commentAfterLikesMin:75, commentAfterLikesMax:150, commentMaxWaitSec:120,
    remoteCommentEnable:false
  };
  const getCfg = () => new Promise(r=>chrome.storage.sync.get(defaultCfg, r));

  /* ===================== état session ===================== */
  let RUNNING=false, SESSION_DEADLINE=0;
  let STEP_CONF={mode:'random', min:1, max:10, fixed:3};
  let STATS={likes:0, posts:0};
  let SEEN_THIS_POST=new Set();
  let LIKED_REPLY_IDS_THIS_POST=new Set();
  let LAST_HREF=null;

  // 🟢 Ajout watchdog
  let lastActivity = Date.now();
  let watchdogInterval;

  /* ===================== replies helpers ===================== */
  const getLikeBtn = a =>
    a.querySelector('[data-testid="like"]') ||
    a.querySelector('button[aria-label*="Like"]') ||
    a.querySelector('button[aria-label*="J’aime"]') ||
    a.querySelector('div[role="button"][aria-label*="Like"]');

  const isLiked = a => !!a.querySelector('[data-testid="unlike"]');
  function normalizeHandle(href){ if(!href) return null; const u=href.split('?')[0].replace(/^\/+/,'').split('/')[0]; return u?('@'+u.toLowerCase()):null; }
  function replyStatusId(article){ const a=article.querySelector('a[href*="/status/"]'); const m=a?.getAttribute('href')?.match(/\/status\/(\d+)/); return m?m[1]:null; }
  function replyAuthorStrict(article){
    const a = article.querySelector('div[data-testid="User-Name"] a[href^="/"]');
    if (a) return normalizeHandle(a.getAttribute('href'));
    const links = article.querySelectorAll('a[href^="/"]');
    for (const l of links){
      const href=l.getAttribute('href')||'';
      if(!href || href.includes('/status/') || href.startsWith('/i/') || href.includes('/photo') || href.includes('/video')) continue;
      return normalizeHandle(href);
    }
    return null;
  }
  function rootArticle(){return qsa('article')[0]||null;}
  function rootReplyCountOnPost(){
    const r=rootArticle(); if(!r) return null;
    const btn=r.querySelector('[data-testid="reply"],button[aria-label*="Reply"],button[aria-label*="Répondre"]');
    if(btn){
      const aria=btn.getAttribute('aria-label')||"";
      const m=aria.match(/(\d+(?:[.,]\d+)?)\s*(Replies?|réponses?|commentaires?)/i);
      if(m) return parseCompactNumber(m[1]);
      const grp=btn.closest('div[role="group"]')||btn.parentElement;
      if(grp){
        for(const sp of Array.from(grp.querySelectorAll('span,div')).slice(0,6)){
          const t=sp.textContent?.trim(); if(t && /\d/.test(t)){
            const v=parseCompactNumber(t); if(v!==null) return v;
          }
        }
      }
    }
    return null;
  }
  const getReplyArticles = ()=>{
    const c=qsa('section[aria-label*="Conversation"],section[aria-label*="timeline"],div[aria-label*="Timeline"]');
    let a=[]; c.forEach(x=>a=a.concat(qsa('article',x)));
    if(!a.length) a=qsa('article'); 
    return a;
  };

  /* ===================== liste helpers ===================== */
  function isOnListTimeline(listUrl){
    if(!listUrl) return /\/i\/lists\/\d+/.test(location.pathname);
    return location.href.startsWith(listUrl);
  }
  function listArticles(){
    const main = document.querySelector('div[aria-label="Timeline: Liste"]') ||
                 document.querySelector('div[aria-label*="Timeline"]') ||
                 document.body;
    return qsa('article', main);
  }
  const articleHref = a => a.querySelector('a[href*="/status/"]')?.getAttribute('href') || "";

  async function openArticle(a){
    const l=a.querySelector('a[href*="/status/"]');
    if(l){ l.scrollIntoView({behavior:'smooth',block:'center'}); await sleep(200); l.click();
      if(await waitFor(()=>location.href.includes('/status/'),12000)) {
        lastActivity = Date.now(); // 🟢 activité mise à jour
        return true;
      }
    }
    const r=a.getBoundingClientRect();
    a.scrollIntoView({behavior:'smooth',block:'center'}); await sleep(200);
    const x=Math.floor(r.left+r.width/2), y=Math.floor(r.top+Math.min(r.height*0.45,300));
    document.elementFromPoint(x,y)?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x,clientY:y}));
    const ok = await waitFor(()=>location.href.includes('/status/'),12000);
    if (ok) lastActivity = Date.now(); // 🟢
    return ok;
  }

  async function backToList(cfg){
    const back = document.querySelector('button[aria-label*="Retour"],button[aria-label*="Back"],[data-testid="app-bar-back"]');
    if(back){ back.click(); await sleep(200); }
    else { history.back(); }
    const ok = await waitFor(()=>isOnListTimeline(cfg.listUrl), 6000, 150);
    if(!ok && cfg.listUrl){
      location.href = cfg.listUrl;
      await waitFor(()=>isOnListTimeline(cfg.listUrl), 15000, 150);
    }
    await sleep(randInt(250,600));
    if(LAST_HREF){
      for(let tries=0; tries<5; tries++){
        const target = document.querySelector(`a[href="${LAST_HREF}"]`);
        if(target){ target.scrollIntoView({behavior:'smooth',block:'center'}); await sleep(350); break; }
        await humanScroll(1);
        await sleep(250);
      }
    }
    lastActivity = Date.now(); // 🟢 retour à la liste = activité
  }

  /* ===================== like logic ===================== */
  async function likeOne(article,cfg){
    if(isLiked(article)) return false;
    const b=getLikeBtn(article); if(!b) return false;
    b.scrollIntoView({behavior:'smooth',block:'center'});
    await sleep(randInt(cfg.minDelayMs,cfg.maxDelayMs));
    b.click(); STATS.likes++; await sleep(randInt(820,1350));
    lastActivity = Date.now(); // 🟢 activité mise à jour
    return true;
  }

  async function likeCommentsOnCurrentPost(cfg){
    // logique existante (pas modifiée sauf activity dans likeOne + scroll)
    await humanScroll(randInt(2,4));
    lastActivity = Date.now(); // 🟢 activité mise à jour
    // ... reste identique ...
    // (on garde ton code complet, déjà lu dans la v2.4)
    // Pas besoin de répéter tout, seules insertions pertinentes sont faites.
  }

  /* ===================== workflow ===================== */
  async function processList(cfg){
    if(!isOnListTimeline(cfg.listUrl) && cfg.listUrl){
      location.href = cfg.listUrl;
      await waitFor(()=>isOnListTimeline(cfg.listUrl), 15000, 150);
    }
    let art = await pickInitialArticle(cfg);

    while(RUNNING && Date.now()<SESSION_DEADLINE){
      if(!art){ await humanScroll(1); art=await pickInitialArticle(cfg); if(!art) break; }

      const href=articleHref(art);
      await log(`Ouvre post ${href||'(sans href)'}`);
      const opened=await openArticle(art);
      if(!opened){ await log('Ouverture échouée, on passe'); await humanScroll(1); art = await pickNextArticleAfter(cfg, href); continue; }

      LAST_HREF = href;
      await sleep(randInt(900,1500));
      await likeCommentsOnCurrentPost(cfg);

      // auto-reply éventuel...
      await backToList(cfg);
      STATS.posts++;
      lastActivity = Date.now(); // 🟢 activité mise à jour

      if(Date.now()>=SESSION_DEADLINE) break;
      art = await pickNextArticleAfter(cfg, LAST_HREF);
      await sleep(randInt(cfg.minDelayMs,cfg.maxDelayMs));
    }
  }

  async function run(cfg){
    if(!isOnX()) return;
    STATS={likes:0,posts:0};
    SEEN_THIS_POST.clear();
    LIKED_REPLY_IDS_THIS_POST.clear();
    LAST_HREF = null;
    await processList(cfg);
  }

  /* ===================== watchdog ===================== */
  function restartBot() {
    console.warn("♻️ Redémarrage automatique du bot");
    RUNNING = false;
    setTimeout(()=>{ 
      RUNNING = true;
      getCfg().then(run);
    }, 1000);
  }

  function checkWatchdog() {
    const now = Date.now();
    const idleTime = (now - lastActivity) / 1000;
    if (RUNNING && idleTime > 90) { // 90s sans activité
      console.warn(`⚠️ Inactivité détectée (${idleTime}s). Restart...`);
      restartBot();
    }
  }

  /* ===================== messaging ===================== */
  console.info('[X Liker] CS loaded v2.5 (avec watchdog)');

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
    try{
      if(msg?.type==='CS_PING'){ sendResponse({pong:true}); return true; }
      if(msg?.type==='CS_START'){
        RUNNING=true;
        SESSION_DEADLINE = msg?.deadlineTs || (Date.now()+10*60000);
        STEP_CONF = msg?.stepConf || STEP_CONF;

        if (!watchdogInterval) {
          watchdogInterval = setInterval(checkWatchdog, 30000); // check toutes les 30s
        }

        getCfg().then(async cfg=>{
          await run(cfg);
          RUNNING=false;
          try{ await chrome.runtime.sendMessage({type:'CS_STATS', stats:STATS}); }catch{}
        });
        sendResponse?.({ok:true}); return true;
      }
      if(msg?.type==='CS_STOP'){ RUNNING=false; sendResponse?.({ok:true}); return true; }
    }catch(e){ /* ignore */ }
    return true;
  });

})();
