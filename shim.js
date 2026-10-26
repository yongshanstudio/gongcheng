/* 永山工程 App — Supabase 連線層（取代 Claude 平台的 db / assets / downloads） */
(function(){
const SB_URL='https://exauxtvqbpdidtrahocq.supabase.co';
const SB_KEY='sb_publishable_arAwGnxdI-99frfVb3pMaA_pDGdzi_f';
const BUCKET='files';
const sb=supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true}});
window.SB=sb;

/* ---------- 資料庫：docs(col,id,data) ---------- */
const chk=r=>{if(r.error)throw r.error;return r.data};
const db={
  doc(path){const [col,id]=path.split('/');return{
    async get(){const d=chk(await sb.from('docs').select('data').eq('col',col).eq('id',id).maybeSingle());return{exists:!!d,data:()=>d?d.data:undefined}},
    async set(o){chk(await sb.from('docs').upsert({col,id,data:o,updated_at:new Date().toISOString()}))},
    async delete(){chk(await sb.from('docs').delete().eq('col',col).eq('id',id))}
  }},
  collection(col){return{async get(){let all=[],from=0;for(;;){const d=chk(await sb.from('docs').select('id,data').eq('col',col).range(from,from+999));all=all.concat(d);if(d.length<1000)break;from+=1000}return{docs:all.map(r=>({id:r.id,data:()=>r.data}))}}}}
};

/* ---------- 檔案：Storage bucket "files"，用短效簽名網址顯示 ---------- */
const SU={};let suAt=0;
const hex=()=>crypto.randomUUID().replace(/-/g,'');
async function sign(ids){ids=[...new Set(ids)].filter(i=>i&&!SU[i]);for(let k=0;k<ids.length;k+=200){const r=await sb.storage.from(BUCKET).createSignedUrls(ids.slice(k,k+200),7*86400);(r.data||[]).forEach(x=>{if(x.signedUrl&&!x.error)SU[x.path]=x.signedUrl})}}
window.SIGNALL=async(st)=>{try{for(const k in SU)delete SU[k];const s=JSON.stringify(st||{});await sign((s.match(/[0-9a-f]{32}/g)||[]));suAt=Date.now()}catch(x){}};
window.SURL=u=>SU[u]||'data:,';
const assets={
  async upload(blob,o){const id=hex(),type=(o&&o.type)||blob.type||'application/octet-stream';chk(await sb.storage.from(BUCKET).upload(id,blob,{contentType:type,upsert:false}));await sign([id]);return{id}},
  async delete(id){await sb.storage.from(BUCKET).remove([id]);delete SU[id]},
  async list(){let n=0,b=0,off=0;for(;;){const d=chk(await sb.storage.from(BUCKET).list('',{limit:1000,offset:off}));d.forEach(f=>{if(f.id){n++;b+=(f.metadata&&f.metadata.size)||0}});if(d.length<1000)break;off+=1000}return{usage:{bytes:b,maxBytes:1073741824,files:n,maxFiles:100000}}}
};

/* ---------- 下載 ---------- */
const downloads={async save({filename,data}){const bl=data instanceof Blob?data:new Blob([data],{type:'text/plain;charset=utf-8'}),u=URL.createObjectURL(bl),a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000)}};

window.claude={use:async n=>{if(n==='db')return db;if(n==='assets')return assets;if(n==='downloads')return downloads;throw new Error('not available: '+n)}};

/* 簽名網址每 6 天更新一次（App 長時間開著時） */
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-suAt>6*864e5&&window.R){SIGNALL(window.GS&&GS()).then(()=>R())}});

/* ---------- 登入 + 首次匯入 ---------- */
const box=h=>{let o=document.getElementById('gate');if(!o){o=document.createElement('div');o.id='gate';document.body.appendChild(o)}o.innerHTML='<div class=gbox>'+h+'</div>';return o};
const css=document.createElement('style');css.textContent='#gate{position:fixed;inset:0;background:var(--bg);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}#gate .gbox{background:var(--c);border-radius:10px;padding:24px;width:100%;max-width:360px;box-shadow:0 4px 24px #0002}#gate h2{margin:0 0 4px;font-size:20px}#gate input{width:100%;padding:10px;margin:6px 0;border:1px solid var(--l);border-radius:6px;font:inherit;background:var(--c);color:var(--t)}#gate button{width:100%;padding:11px;margin-top:10px;border:0;border-radius:6px;background:var(--a);color:#fff;font:inherit;cursor:pointer}#gate .er{color:var(--bad);min-height:1.4em;font-size:14px}';document.head.appendChild(css);

function login(){return new Promise(res=>{const o=box('<h2>永山工程</h2><div class=m style="margin-bottom:10px">請登入</div><form><input type=email name=e placeholder="Email" autocomplete=username required><input type=password name=p placeholder="密碼" autocomplete=current-password required><div class=er></div><button>登入</button></form>');
o.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const f=ev.target,er=o.querySelector('.er');er.textContent='登入中…';const r=await sb.auth.signInWithPassword({email:f.e.value.trim(),password:f.p.value});if(r.error){er.textContent='登入失敗：Email 或密碼不正確';return}o.remove();res()}})}

async function maybeImport(){const r=await sb.from('docs').select('id',{count:'exact',head:true});if(r.error||r.count>0)return;
await new Promise(res=>{const o=box('<h2>匯入舊資料</h2><div class=m>第一次使用：請選擇 Claude 傳給你的「工程管理-搬家資料.zip」。</div><input type=file accept=".zip"><div class=er></div><button id=skip style="background:#888">略過，從空白開始</button>');
o.querySelector('#skip').onclick=()=>{o.remove();res()};
o.querySelector('input').onchange=async ev=>{const er=o.querySelector('.er');try{er.textContent='讀取中…';const z=await JSZip.loadAsync(ev.target.files[0]),data=JSON.parse(await z.file('data.json').async('string'));
const fs=Object.keys(z.files).filter(n=>n.startsWith('files/')&&!z.files[n].dir);let i=0;
for(const n of fs){i++;er.textContent='上傳檔案 '+i+' / '+fs.length;const id=n.slice(6).replace(/\.[^.]+$/,''),ty=n.endsWith('.pdf')?'application/pdf':n.match(/\.png$/)?'image/png':'image/jpeg';const u=await sb.storage.from(BUCKET).upload(id,await z.file(n).async('blob'),{contentType:ty,upsert:true});if(u.error)throw u.error}
for(let k=0;k<data.docs.length;k+=200){er.textContent='寫入資料 '+Math.min(k+200,data.docs.length)+' / '+data.docs.length;chk(await sb.from('docs').upsert(data.docs.slice(k,k+200).map(d=>({col:d.col,id:d.id,data:d.data}))))}
o.remove();res()}catch(x){er.textContent='匯入失敗：'+(x.message||x)}}})}

window.GATE=async()=>{const {data}=await sb.auth.getSession();if(!data.session)await login();await maybeImport()};
window.LOGOUT=async()=>{await sb.auth.signOut();location.reload()};
})();
