// contentScript.js — v2.4
(() => {
  'use strict';

  /* ===================== utils ===================== */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randInt = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
  const qsa = (sel,root=document)=>Array.from(root.querySelectorAll(sel));
  const log = async (t)=>{ try{ await chrome.runtime.sendMessage({type:'LOG_EVENT', text:t}); }catch{} };

  function isOnX(){return location.hostname.includes('x.com')||location.hostname.includes('twitter.com');}
  function waitFor(fn,t=12000,p=120){const t0=Date.now();return new Promise(async res=>{while(Date.now()-t0<t){try{if(await fn())return res(true);}catch{}await sleep(p);}res(false);});}
  async function humanScroll(n=3){for(let i=0;i<n;i++){window.scrollBy({top:randInt(380,840),behavior:'smooth'});await sleep(randInt(650,1200));}}
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

    // commentaire local laissé en place (non utilisé ici)
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
  let LAST_HREF=null; // href du dernier post ouvert (pour se repositionner)

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
    if(!a.length) a=qsa('article'); // fallback
    return a;
  };

  /* ===================== liste helpers ===================== */
  function isOnListTimeline(listUrl){
    if(!listUrl) return /\/i\/lists\/\d+/.test(location.pathname);
    // on tolère un éventuel trailing slash / params
    return location.href.startsWith(listUrl);
  }

  function listArticles(){
    // timeline réelle de la liste (pas la page “/username/lists”)
    const main = document.querySelector('div[aria-label="Timeline: Liste"]') ||
                 document.querySelector('div[aria-label*="Timeline"]') ||
                 document.body;
    return qsa('article', main);
  }
  const articleHref = a => a.querySelector('a[href*="/status/"]')?.getAttribute('href') || "";

  function repliesOnListCard(a){
    const btn=a.querySelector('[data-testid="reply"],button[aria-label*="Reply"],button[aria-label*="Répondre"],div[role="button"][aria-label*="Reply"]');
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

  async function openArticle(a){
    const l=a.querySelector('a[href*="/status/"]');
    if(l){ l.scrollIntoView({behavior:'smooth',block:'center'}); await sleep(200); l.click();
      if(await waitFor(()=>location.href.includes('/status/'),12000)) return true;
    }
    const r=a.getBoundingClientRect();
    a.scrollIntoView({behavior:'smooth',block:'center'}); await sleep(200);
    const x=Math.floor(r.left+r.width/2), y=Math.floor(r.top+Math.min(r.height*0.45,300));
    document.elementFromPoint(x,y)?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x,clientY:y}));
    return await waitFor(()=>location.href.includes('/status/'),12000);
  }

  async function backToList(cfg){
    // 1) back “naturel”
    const back = document.querySelector('button[aria-label*="Retour"],button[aria-label*="Back"],[data-testid="app-bar-back"]');
    if(back){ back.click(); await sleep(200); }
    else { history.back(); }

    // 2) attendre qu’on soit sur la bonne page; sinon forcer
    const ok = await waitFor(()=>isOnListTimeline(cfg.listUrl), 6000, 150);
    if(!ok && cfg.listUrl){
      location.href = cfg.listUrl;
      await waitFor(()=>isOnListTimeline(cfg.listUrl), 15000, 150);
    }
    await sleep(randInt(250,600));

    // 3) se repositionner autour de LAST_HREF si possible
    if(LAST_HREF){
      for(let tries=0; tries<5; tries++){
        const target = document.querySelector(`a[href="${LAST_HREF}"]`);
        if(target){ target.scrollIntoView({behavior:'smooth',block:'center'}); await sleep(350); break; }
        await humanScroll(1);
        await sleep(250);
      }
    }
  }

  function computeStep(){ return STEP_CONF.mode==='fixed' ? STEP_CONF.fixed : randInt(STEP_CONF.min, STEP_CONF.max); }

  async function pickInitialArticle(cfg){
    await humanScroll(randInt(cfg.listPrefetchScrollsMin,cfg.listPrefetchScrollsMax));
    const arts=listArticles(); if(!arts.length) return null;
    const pool=arts.slice(0, Math.max(10, cfg.listScanBatchSize));
    for (let i=0;i<10;i++){
      const cand = pool[randInt(0,pool.length-1)];
      const replies=repliesOnListCard(cand);
      if (replies!=null && replies < (cfg.listMinComments||0)) continue;
      return cand;
    }
    return pool[0];
  }

  async function pickNextArticleAfter(cfg, lastHref){
    let arts=listArticles(); let hrefs=arts.map(articleHref);
    let idx = lastHref ? hrefs.indexOf(lastHref) : -1;
    let step = computeStep();

    for (let tries=0; tries<4; tries++){
      if (idx>=0 && idx+step < arts.length) return arts[idx+step];
      await humanScroll(1); await sleep(220);
      arts=listArticles(); hrefs=arts.map(articleHref); idx = lastHref ? hrefs.indexOf(lastHref) : -1;
    }
    // fallback : proche du haut de la zone chargée
    return arts[Math.min(arts.length-1, randInt(0, Math.min(12, arts.length-1)))];
  }

  /* ===================== reveal “More replies” (sans SPAM) ===================== */
  // IMPORTANT : on NE clique PAS sur “Afficher les spams probables”
  const MORE_ONLY_PATTERNS = [
    /Afficher plus de réponses/i,
    /Plus de réponses/i,
    /Show more replies/i,
    /Show replies/i
  ];
  const EXCLUDE_SPAM_PAT = /spam/i; // exclut "spams probables", "spam"

  const REVEAL_CLICKED_THIS_POST = new Set();
  function clickRevealMoreRepliesOnly(){
    const candidates = qsa('button,div[role="button"],span').filter(el=>{
      if(!el || !el.isConnected) return false;
      if(!el.offsetParent) return false;
      const t = (el.textContent||'').trim();
      if(!t || EXCLUDE_SPAM_PAT.test(t)) return false;         // <<<< n'ouvre pas les SPAMs
      return MORE_ONLY_PATTERNS.some(r=>r.test(t));
    });
    for(const el of candidates){
      const label = (el.textContent||'').trim();
      if(REVEAL_CLICKED_THIS_POST.has(label)) continue;
      el.scrollIntoView({behavior:'smooth',block:'center'});
      el.click();
      REVEAL_CLICKED_THIS_POST.add(label);
      return true; // un seul bouton à la fois
    }
    return false;
  }

  /* ===================== like logic ===================== */
  async function likeOne(article,cfg){
    if(isLiked(article)) return false;
    const b=getLikeBtn(article); if(!b) return false;
    b.scrollIntoView({behavior:'smooth',block:'center'});
    await sleep(randInt(cfg.minDelayMs,cfg.maxDelayMs));
    b.click(); STATS.likes++; await sleep(randInt(820,1350));
    return true;
  }

  function pickPool(articles){
    const base = articles
      .map(a => ({ el:a, author:replyAuthorStrict(a), rid:replyStatusId(a), btn:getLikeBtn(a) }))
      .filter(x => x.btn && !isLiked(x.el) &&
        (!x.author || !SEEN_THIS_POST.has(x.author)) &&
        (!x.rid    || !LIKED_REPLY_IDS_THIS_POST.has(x.rid))
      );
    for (let i=base.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[base[i],base[j]]=[base[j],base[i]];}
    return base;
  }

  async function likeCommentsOnCurrentPost(cfg){
    SEEN_THIS_POST.clear(); LIKED_REPLY_IDS_THIS_POST.clear(); REVEAL_CLICKED_THIS_POST.clear();
    if(!location.href.includes('/status/')) return;

    const total=rootReplyCountOnPost();
    const pct=randInt(cfg.likePercentMin,cfg.likePercentMax);
    let target = total!=null ? Math.round(pct/100 * total) : null;
    if(target==null){ const first=getReplyArticles(); target=Math.round(pct/100 * Math.min(first.length, 999)); }
    target=Math.min(target, cfg.maxLikesPerPost||target);

    const sample=getReplyArticles().slice(0,30);
    const ratio= sample.length ? sample.filter(isLiked).length / sample.length : 0;
    if(ratio >= (cfg.skipIfLikedRatioGTE??0.6)){ await log('Skip: trop de replies déjà likées'); return; }

    let done=0;
    let emptyPoolStreak=0;     // aucune candidate cette boucle
    let noProgressLoops=0;     // aucune like cette boucle
    let scrollsThisPost=0;
    const MAX_SCROLLS_PER_POST = 14;
    const MAX_EMPTY_STREAK     = 8;
    const MAX_NO_PROGRESS      = 6;

    await humanScroll(randInt(2,4));

    while(RUNNING && Date.now()<SESSION_DEADLINE && done<target){
      // Déplier uniquement “plus de réponses” (pas SPAM)
      if (emptyPoolStreak >= 2 || noProgressLoops >= 2) {
        const clicked = clickRevealMoreRepliesOnly();
        if (clicked) await sleep(700);
      }

      const pool=pickPool(getReplyArticles());
      if(!pool.length){
        emptyPoolStreak++;
        if (emptyPoolStreak >= MAX_EMPTY_STREAK || scrollsThisPost >= MAX_SCROLLS_PER_POST || (nearBottom() && emptyPoolStreak>=3)) {
          await log('Skip: aucune nouvelle réponse — retour à la liste');
          break;
        }
        await sleep(randInt(650,1100));
        await humanScroll(1); scrollsThisPost++;
        continue;
      }

      let likedThisLoop=false;
      for(const it of pool){
        if(!RUNNING || Date.now()>=SESSION_DEADLINE || done>=target) break;
        if ((it.author && SEEN_THIS_POST.has(it.author)) ||
            (it.rid && LIKED_REPLY_IDS_THIS_POST.has(it.rid)) ||
            isLiked(it.el)) continue;

        const ok = await likeOne(it.el, cfg);
        if (ok) {
          likedThisLoop=true;
          if (it.author) SEEN_THIS_POST.add(it.author);
          if (it.rid)    LIKED_REPLY_IDS_THIS_POST.add(it.rid);
          done++;
        }
        await sleep(randInt(cfg.minDelayMs,cfg.maxDelayMs));
      }

      if (likedThisLoop){ noProgressLoops=0; emptyPoolStreak=0; }
      else             { noProgressLoops++; }

      if (done<target){
        if (noProgressLoops >= MAX_NO_PROGRESS) {
          await log('Stop: pas de progrès — retour à la liste');
          break;
        }
        await sleep(randInt(cfg.scrollPauseMinMs,cfg.scrollPauseMaxMs));
        await humanScroll(randInt(1,2)); scrollsThisPost++;
        if (scrollsThisPost >= MAX_SCROLLS_PER_POST) {
          await log('Stop: trop de scrolls — retour à la liste');
          break;
        }
      }
    }
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

      LAST_HREF = href; // mémorise pour se repositionner ensuite
      await sleep(randInt(900,1500));
      await likeCommentsOnCurrentPost(cfg);

        // 🎯 40% du temps, demander à l'extension Auto-Reply de commenter
        if (Math.random() < 0.4) {
          try {
            const AUTO_REPLY_ID = "akjdmaofpcgjkadfadhmamjlokbcflpd"; // ID de ton bot Auto-Reply
            await chrome.runtime.sendMessage(AUTO_REPLY_ID, {
              action: "COMMENT",
              postUrl: location.href
            });
            await log("✅ Demande envoyée au bot Auto-Reply (40%).");
          } catch (err) {
            console.error("❌ Erreur envoi vers Auto-Reply :", err);
          }
        }

        await backToList(cfg);
        STATS.posts++;

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

  /* ===================== messaging ===================== */
  console.info('[X Liker] CS loaded v2.4');

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
    try{
      if(msg?.type==='CS_PING'){ sendResponse({pong:true}); return true; }
      if(msg?.type==='CS_START'){
        RUNNING=true;
        SESSION_DEADLINE = msg?.deadlineTs || (Date.now()+10*60000);
        STEP_CONF = msg?.stepConf || STEP_CONF;
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
