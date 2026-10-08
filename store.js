/* Armazenamento local (offline) — substitui o banco, as fotos e os downloads do painel online.
   Tudo fica no próprio aparelho, em IndexedDB:
   - "docs":  registros {key, col, id, data, mod, deleted?}  (exclusões viram marcas, para mesclar backups)
   - "blobs": fotos/PDFs {id, blob, type, criado}                                                       */
(function(){
  const DBNAME = "abastecimento-7bbm", VER = 1, APP_ID = "abastecimento-7bbm";
  let dbp = null;
  const L = {};            // ouvintes por coleção
  const urls = new Map();  // id da foto -> object URL

  function openDb(){
    return dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DBNAME, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if(!d.objectStoreNames.contains("docs")){ const s = d.createObjectStore("docs", {keyPath:"key"}); s.createIndex("col","col"); }
        if(!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", {keyPath:"id"});
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("banco bloqueado por outra janela"));
    }));
  }
  const rq = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  async function run(stores, mode, fn){
    const d = await openDb();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode); let out;
      Promise.resolve(fn(t)).then(v => { out = v; }, e => { try{ t.abort(); }catch(_){} rej(e); });
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("abortado"));
    });
  }
  const rid = (n=20) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""); };
  const hex32 = () => { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2,"0")).join(""); };
  const clone = o => JSON.parse(JSON.stringify(o));

  async function allRecords(){ return run(["docs"], "readonly", t => rq(t.objectStore("docs").getAll())); }
  async function liveOf(col){
    const recs = await run(["docs"], "readonly", t => rq(t.objectStore("docs").index("col").getAll(col)));
    return recs.filter(r => !r.deleted);
  }
  const snap = list => ({ docs: list.map(r => ({ id:r.id, exists:true, data:() => r.data, metadata:{fromCache:false,hasPendingWrites:false} })), size:list.length, empty:!list.length, docChanges:() => [] });
  async function emit(col){
    const fns = L[col]; if(!fns || !fns.size) return;
    const s = snap(await liveOf(col));
    fns.forEach(fn => { try{ fn(s); }catch(e){ console.error(e); } });
  }
  async function write(col, id, data){
    await run(["docs"], "readwrite", t => rq(t.objectStore("docs").put({ key:col+"/"+id, col, id, data:clone(data), mod:Date.now() })));
    emit(col);
  }
  async function remove(col, id){
    await run(["docs"], "readwrite", t => rq(t.objectStore("docs").put({ key:col+"/"+id, col, id, deleted:true, mod:Date.now() })));
    emit(col);
  }

  /* --- banco: mesma interface usada pela página (collection/doc/onSnapshot) --- */
  function collection(col){
    const q = {
      path: col,
      where(){ return q; }, orderBy(){ return q; }, limit(){ return q; },
      onSnapshot(next, err){
        (L[col] || (L[col] = new Set())).add(next);
        liveOf(col).then(list => next(snap(list)), e => err && err({code:"unavailable", message:String(e)}));
        return () => L[col].delete(next);
      },
      async get(){ return snap(await liveOf(col)); },
      async add(data){ const id = rid(); await write(col, id, data); return q.doc(id); },
      doc(id){
        id = id || rid();
        return {
          id, path: col+"/"+id,
          async set(data){ await write(col, id, data); },
          async update(data){
            const r = await run(["docs"], "readonly", t => rq(t.objectStore("docs").get(col+"/"+id)));
            if(!r || r.deleted) throw {code:"invalid_argument", message:"documento não existe"};
            await write(col, id, Object.assign({}, r.data, data));
          },
          async delete(){ await remove(col, id); },
          async get(){
            const r = await run(["docs"], "readonly", t => rq(t.objectStore("docs").get(col+"/"+id)));
            const ok = !!(r && !r.deleted);
            return { id, exists:ok, data:() => ok ? r.data : undefined };
          }
        };
      }
    };
    return q;
  }
  const db = { collection, doc(path){ const i = path.lastIndexOf("/"); return collection(path.slice(0,i)).doc(path.slice(i+1)); } };

  /* --- fotos --- */
  async function loadUrls(){
    const all = await run(["blobs"], "readonly", t => rq(t.objectStore("blobs").getAll()));
    for(const b of all) if(!urls.has(b.id)) urls.set(b.id, URL.createObjectURL(b.blob));
  }
  const assets = {
    async upload(blob, opts){
      const type = (opts && opts.type) || blob.type || "application/octet-stream";
      const id = hex32();
      await run(["blobs"], "readwrite", t => rq(t.objectStore("blobs").put({ id, blob, type, criado:new Date().toISOString() })));
      const url = URL.createObjectURL(blob); urls.set(id, url);
      return { id, url, sizeBytes: blob.size, contentType: type };
    },
    async delete(id){
      await run(["blobs"], "readwrite", t => rq(t.objectStore("blobs").delete(id)));
      const u = urls.get(id); if(u){ URL.revokeObjectURL(u); urls.delete(id); }
      return { deleted:true };
    },
    async list(){ return run(["blobs"], "readonly", t => rq(t.objectStore("blobs").getAll())); }
  };

  /* --- salvar arquivo no aparelho --- */
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const mimeOf = name => /\.xlsx$/i.test(name) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : /\.zip$/i.test(name) ? "application/zip" : "application/octet-stream";
  // No iPhone o arquivo vai para a tela "Compartilhar" do sistema (Salvar em Arquivos, WhatsApp, e-mail…)
  async function compartilhar(file){
    try{ await navigator.share({ files:[file], title:file.name }); return "ok"; }
    catch(e){ return e && e.name === "AbortError" ? "cancelado" : (e && e.name === "NotAllowedError" ? "precisa-toque" : "falhou"); }
  }
  function pedirToque(file){
    // Quando o arquivo demora a ficar pronto, o iPhone exige um novo toque para abrir a tela de compartilhar
    return new Promise(res => {
      const ov = document.createElement("div");
      ov.className = "modal"; ov.setAttribute("role","dialog"); ov.setAttribute("aria-modal","true");
      ov.innerHTML = '<div class="modal-box" style="max-width:420px"><div class="modal-head"><h2>Arquivo pronto</h2></div>' +
        '<p style="margin:0;color:var(--muted)"></p>' +
        '<div class="form-actions"><button type="button" class="btn primary" data-a="share">Compartilhar / Salvar</button>' +
        '<button type="button" class="btn" data-a="close">Fechar</button></div></div>';
      ov.querySelector("p").textContent = file.name + " — toque em Compartilhar e escolha “Salvar em Arquivos”, WhatsApp ou e-mail.";
      document.body.appendChild(ov);
      ov.addEventListener("click", async ev => {
        const a = ev.target.closest("[data-a]"); if(!a) return;
        if(a.dataset.a === "share"){ const r = await compartilhar(file); if(r === "cancelado") return; ov.remove(); res(r); }
        else { ov.remove(); res("cancelado"); }
      });
      ov.querySelector('[data-a="share"]').focus();
    });
  }
  const downloads = {
    async save({filename, data}){
      const blob = data instanceof Blob ? data : new Blob([data]);
      if(isIOS && navigator.share && typeof File === "function"){
        const file = new File([blob], filename, { type: blob.type || mimeOf(filename) });
        if(!navigator.canShare || navigator.canShare({ files:[file] })){
          let r = await compartilhar(file);
          if(r === "precisa-toque") r = await pedirToque(file);
          if(r === "ok") return { status:"saved" };
          if(r === "cancelado") throw { code:"declined", message:"cancelado" };
          // "falhou": cai para o download comum abaixo
        }
      }
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = u; a.download = filename; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
      return { status:"saved" };
    }
  };

  /* --- backup (.zip) e importação com mesclagem --- */
  const extOf = type => ({ "image/jpeg":"jpg", "image/png":"png", "image/webp":"webp", "image/gif":"gif", "application/pdf":"pdf" })[type] || "bin";
  async function exportBackup(){
    const zip = new JSZip();
    const recs = await allRecords();
    const blobs = await assets.list();
    zip.file("dados.json", JSON.stringify({ app:APP_ID, versao:1, geradoEm:new Date().toISOString(), registros:recs }, null, 1));
    const idx = {};
    for(const b of blobs){ const name = "fotos/"+b.id+"."+extOf(b.type); idx[b.id] = { arquivo:name, type:b.type, criado:b.criado }; zip.file(name, b.blob); }
    zip.file("fotos.json", JSON.stringify(idx, null, 1));
    const out = await zip.generateAsync({ type:"blob", compression:"STORE" });
    return { blob: out, registros: recs.filter(r => !r.deleted).length, fotos: blobs.length };
  }
  function referenced(recs){
    const ids = new Set();
    for(const r of recs){ if(r.deleted || !r.data || !r.data.fotos) continue;
      for(const k of Object.keys(r.data.fotos)) for(const it of (r.data.fotos[k] || [])) if(it && it.id) ids.add(it.id); }
    return ids;
  }
  async function importBackup(file){
    const zip = await JSZip.loadAsync(file);
    const f = zip.file("dados.json"); if(!f) throw new Error("O arquivo não é um backup deste aplicativo (falta dados.json).");
    const dados = JSON.parse(await f.async("string"));
    if(dados.app !== APP_ID || !Array.isArray(dados.registros)) throw new Error("O arquivo não é um backup deste aplicativo.");
    const idx = zip.file("fotos.json") ? JSON.parse(await zip.file("fotos.json").async("string")) : {};
    // fotos: só as que ainda não existem
    const tem = new Set((await assets.list()).map(b => b.id));
    const novasFotos = [];
    for(const [id, meta] of Object.entries(idx)){
      if(tem.has(id) || !/^[0-9a-f]{32}$/.test(id)) continue;
      const zf = zip.file(meta.arquivo); if(!zf) continue;
      const blob = new Blob([await zf.async("arraybuffer")], { type: meta.type });
      novasFotos.push({ id, blob, type: meta.type, criado: meta.criado || new Date().toISOString() });
    }
    // registros: vence o mais recente (inclusive exclusões)
    const locais = new Map((await allRecords()).map(r => [r.key, r]));
    let novos = 0, atualizados = 0, excluidos = 0; const cols = new Set();
    const aplicar = [];
    for(const r of dados.registros){
      if(!r || typeof r.key !== "string" || typeof r.col !== "string" || typeof r.id !== "string") continue;
      const l = locais.get(r.key);
      if(l && (l.mod || 0) >= (r.mod || 0)) continue;
      aplicar.push(r); cols.add(r.col);
      if(r.deleted){ if(l && !l.deleted) excluidos++; } else if(l && !l.deleted) atualizados++; else novos++;
    }
    await run(["docs","blobs"], "readwrite", t => {
      const ds = t.objectStore("docs"), bs = t.objectStore("blobs");
      for(const r of aplicar) ds.put(r);
      for(const b of novasFotos) bs.put(b);
    });
    for(const b of novasFotos) urls.set(b.id, URL.createObjectURL(b.blob));
    const removidas = await limparFotosSoltas();
    cols.forEach(c => emit(c));
    return { novos, atualizados, excluidos, fotos: novasFotos.length, removidas };
  }
  async function limparFotosSoltas(){
    const ref = referenced(await allRecords());
    const soltas = (await assets.list()).filter(b => !ref.has(b.id));
    for(const b of soltas) await assets.delete(b.id);
    return soltas.length;
  }
  async function uso(){
    const recs = (await allRecords()).filter(r => !r.deleted).length;
    const blobs = await assets.list();
    const bytes = blobs.reduce((s,b) => s + (b.blob ? b.blob.size : 0), 0);
    let quota = null; try{ const e = await navigator.storage.estimate(); quota = e.quota || null; }catch(_){}
    return { registros: recs, fotos: blobs.length, bytes, quota };
  }

  const ready = (async () => {
    try{ if(navigator.storage && navigator.storage.persist) await navigator.storage.persist(); }catch(_){}
    await openDb(); await loadUrls();
  })();

  window.LocalStore = { ready, urlFor: id => urls.get(id) || "", exportBackup, importBackup, limparFotosSoltas, uso };
  // mesma porta de entrada da página online: claude.use("db" | "assets" | "downloads")
  window.claude = { use: async name => { await ready; return name === "db" ? db : name === "assets" ? assets : name === "downloads" ? downloads : null; } };
})();
