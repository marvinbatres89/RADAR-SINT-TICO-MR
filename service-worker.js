/* RADAR SINTÉTICO MR V1.10.2 · siempre pide la versión nueva a GitHub; lo guardado solo se usa sin internet. */
const CACHE='radar-mr-v1102';
const ASSETS=['./','./index.html','./style.css?v=1102','./app.js?v=1102','./manifest.json','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS.map(u=>new Request(u,{cache:'reload'})))).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const same=new URL(e.request.url).origin===self.location.origin;
  e.respondWith(fetch(same?new Request(e.request.url,{cache:'no-store',credentials:'same-origin'}):e.request).then(r=>{if(r.ok){const c=r.clone();caches.open(CACHE).then(cache=>cache.put(e.request,c))}return r})
    .catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||(e.request.mode==='navigate'?caches.match('./index.html'):Response.error()))));
});
