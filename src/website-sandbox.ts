import { WEBSITE_BASE } from './lib/w3/website-html.js'

// Hostname of WEBSITE_BASE ('website.w3fs'), for the same-origin checks in the injected srcdoc JS.
// Single source of truth — WEBSITE_BASE is defined once in website-html.ts.
const WEBSITE_HOST = new URL(WEBSITE_BASE).hostname

type RenderMessage = {
  type: 'render'
  html: string
  assetMap?: Record<string, string>
  chainId?: number
  pageUrl?: string    // canonical w3:// host, for rewriting broken self-referential share links
  fragment?: string   // #… client-side state to restore into the sandbox's location.hash
  prefersDark?: boolean  // OS color scheme, detected reliably by the renderer
}

type BridgeMessage = {
  type: 'eth-request' | 'eth-response' | 'w3-navigate' | 'polyfill-ready' | 'wallet-event' | 'page-press'
  [key: string]: unknown
}

let frame = document.getElementById('frame') as HTMLIFrameElement

// Relay eth-request from the website iframe up to renderer.html, and eth-response
// back down from renderer.html into the website iframe.
window.addEventListener('message', (event: MessageEvent<BridgeMessage | RenderMessage>) => {
  if (!event.data) return

  if (event.data.type === 'eth-request') {
    if (event.source === frame.contentWindow) window.parent.postMessage(event.data, '*')
  }

  if (event.data.type === 'w3-navigate' && event.source === frame.contentWindow) {
    window.parent.postMessage(event.data, '*')
  }

  if (event.data.type === 'polyfill-ready' && event.source === frame.contentWindow) {
    window.parent.postMessage({ type: 'polyfill-ready' }, '*')
  }

  // A press inside the website: the host's pills close their menus on it (a press in this frame never
  // reaches the host page itself).
  if (event.data.type === 'page-press' && event.source === frame.contentWindow) {
    window.parent.postMessage({ type: 'page-press' }, '*')
  }

  if (event.data.type === 'eth-response' && event.source === window.parent) {
    frame.contentWindow?.postMessage(event.data, '*')
  }

  if (event.data.type === 'wallet-event' && event.source === window.parent) {
    frame.contentWindow?.postMessage(event.data, '*')
  }
})

// Polyfills injected before any website code runs.
// The iframe intentionally has an opaque sandbox origin so the manifest sandbox
// can allow inline website scripts. Storage APIs are shimmed before app code runs.
function makePolyfill(chainId: number, pageUrl = '', fragment = '', prefersDark = false): string {
  const chainIdHex = '0x' + chainId.toString(16)
  return makePolyfillScript(chainIdHex, pageUrl, fragment, prefersDark)
}

function makePolyfillScript(chainIdHex: string, pageUrl: string, fragment: string, prefersDark: boolean): string {
const _pu = JSON.stringify(pageUrl)      // canonical w3:// host, safely embedded
const _fr = JSON.stringify(fragment)     // #… state to restore, safely embedded
const _pd = prefersDark ? 'true' : 'false'
return '<scr' + 'ipt>(function(){' +
  // matchMedia shim: a freshly-created srcdoc iframe can evaluate prefers-color-scheme to
  // the wrong value at parse time, so websites reading it synchronously at init render
  // light at random. Return the renderer's reliably-detected OS scheme for color-scheme
  // queries; delegate every other query (pointer:coarse, resize, …) to the native impl.
  'try{var _mm=window.matchMedia?window.matchMedia.bind(window):null;var _pd=' + _pd + ';' +
    'window.matchMedia=function(q){q=String(q);' +
      'if(/prefers-color-scheme/i.test(q)){var m=/dark/i.test(q)?_pd:!_pd;' +
        'return{matches:m,media:q,onchange:null,addListener:function(){},removeListener:function(){},' +
          'addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return false;}};}' +
      'return _mm?_mm(q):{matches:false,media:q,addListener:function(){},removeListener:function(){},' +
        'addEventListener:function(){},removeEventListener:function(){}};};' +
  '}catch(e){}' +
  // In-memory localStorage/sessionStorage shim, persisted to window.name so it
  // survives a same-frame reload the way a real browser keeps storage across
  // location.reload() — without touching the extension's real storage. A fresh
  // frame (a new navigation) starts with a fresh window.name, so state is scoped
  // to the page's lifetime. Wrapped in a Proxy so websites that use property
  // access (s[key], delete s[key]) work alongside getItem/setItem.
  'function MS(nk){var s={};try{s=JSON.parse(window.name||"{}")[nk]||{}}catch(e){}' +
    'function P(){try{var a={};try{a=JSON.parse(window.name||"{}")}catch(e){}a[nk]=s;window.name=JSON.stringify(a)}catch(e){}}' +
    'var api={' +
      'get length(){return Object.keys(s).length},' +
      'key:function(i){return Object.keys(s)[i]||null},' +
      'getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},' +
      'setItem:function(k,v){s[String(k)]=String(v);P()},' +
      'removeItem:function(k){delete s[String(k)];P()},' +
      'clear:function(){s={};P()}' +
    '};' +
    'return new Proxy(api,{' +
      'get:function(t,p){if(p in t)return t[p];return Object.prototype.hasOwnProperty.call(s,p)?s[p]:undefined},' +
      'set:function(t,p,v){if(p in t){t[p]=v}else{s[String(p)]=String(v);P()}return true},' +
      'deleteProperty:function(t,p){if(Object.prototype.hasOwnProperty.call(s,p)){delete s[p];P()}return true},' +
      'has:function(t,p){return (p in t)||Object.prototype.hasOwnProperty.call(s,p)},' +
      'ownKeys:function(){return Object.keys(s)},' +
      'getOwnPropertyDescriptor:function(t,p){if(Object.prototype.hasOwnProperty.call(s,p))return{value:s[p],writable:true,enumerable:true,configurable:true};return undefined}' +
    '})}' +
  'try{Object.defineProperty(window,"localStorage",{value:MS("l"),configurable:true});}catch(e){}' +
  'try{Object.defineProperty(window,"sessionStorage",{value:MS("s"),configurable:true});}catch(e){}' +
  // Cache Storage: reading window.caches throws in a sandboxed (opaque-origin) frame, which breaks any page
  // that opens a cache to keep downloads (wasm/zkey files, assets). Provide a working in-memory CacheStorage:
  // open/match/put/add/delete/keys behave normally for the life of the page, but nothing persists across loads.
  'try{(function(){' +
    'var S={};' +
    'function K(r){try{return (r instanceof Request)?r.url:new URL(String(r),location.href).href;}catch(e){return String(r);}}' +
    'function C(n){var m=S[n]||(S[n]=new Map());return{' +
      'match:function(r){var v=m.get(K(r));return Promise.resolve(v?v.clone():undefined);},' +
      'matchAll:function(r){if(r===undefined)return Promise.resolve(Array.from(m.values()).map(function(v){return v.clone();}));var v=m.get(K(r));return Promise.resolve(v?[v.clone()]:[]);},' +
      'put:function(r,res){m.set(K(r),res);return Promise.resolve();},' +
      'add:function(r){return fetch(r).then(function(res){if(!res.ok)throw new TypeError("Request failed");m.set(K(r),res);});},' +
      'addAll:function(rs){return Promise.all(Array.from(rs).map(function(r){return this.add(r);},this)).then(function(){});},' +
      'delete:function(r){return Promise.resolve(m.delete(K(r)));},' +
      'keys:function(){return Promise.resolve(Array.from(m.keys()).map(function(u){return new Request(u);}));}' +
    '};}' +
    'var cs={' +
      'open:function(n){return Promise.resolve(C(String(n)));},' +
      'has:function(n){return Promise.resolve(String(n) in S);},' +
      'delete:function(n){n=String(n);var had=n in S;delete S[n];return Promise.resolve(had);},' +
      'keys:function(){return Promise.resolve(Object.keys(S));},' +
      'match:function(r){var k=K(r);for(var n in S){var v=S[n].get(k);if(v)return Promise.resolve(v.clone());}return Promise.resolve(undefined);}' +
    '};' +
    'Object.defineProperty(window,"caches",{get:function(){return cs;},configurable:true});' +
  '})();}catch(e){}' +
  // history.replaceState/pushState shim. In this opaque-origin srcdoc frame (origin "null", URL
  // about:srcdoc) a relative URL resolves against the PARENT frame (chrome-extension://…), so any
  // "#hash", "/path" or "?query" URL throws SecurityError. That breaks apps that keep the hash in
  // sync (e.g. history.replaceState(null,"","#"+name)) and made the share-link restore below fail
  // silently. Only "about:srcdoc#…" is accepted here, so rewrite the URL to its fragment on that
  // base; a URL with no fragment can't be represented in a srcdoc, so leave the URL unchanged
  // rather than throw. The state object is passed through untouched.
  'try{var _H=window.history;["replaceState","pushState"].forEach(function(k){var o=_H[k];' +
    'if(typeof o!=="function")return;' +
    '_H[k]=function(s,t,u){' +
      'if(u!=null){u=String(u);var i=u.indexOf("#");u=i>=0?"about:srcdoc"+u.slice(i):undefined;}' +
      'return o.call(_H,s,t,u);};});}catch(e){}' +
  // Restore share-link state: the website reads location.hash on load, but about:srcdoc has
  // an empty hash. Set it (from the w3:// URL fragment) before the website's scripts run so it
  // rehydrates (#token=ETH&out=wstETH). Same-document, fires hashchange — harmless.
  'var _FR=' + _fr + ';' +
  // replaceState, NOT location.hash=: an iframe hash change pushes an entry onto the
  // browser session history, so setting it directly made Back require extra clicks to
  // unwind invisible iframe entries. replaceState updates location.hash (which the website
  // reads on load) without adding history.
  'try{if(_FR)history.replaceState(history.state,"",_FR);}catch(e){}' +
  // Clipboard write shim: the async Clipboard API is blocked by Permissions Policy in
  // this sandboxed (opaque-origin) srcdoc iframe, so navigator.clipboard.writeText()
  // rejects. Fall back to the legacy execCommand("copy"), which works inside a sandboxed
  // iframe during a user gesture. Only WRITE is shimmed — clipboard reading stays off.
  // Also rewrite the website's self-referential share links: it builds them from location.*,
  // which is about:srcdoc here, so they come out as "nullsrcdoc#…" / "about:srcdoc#…".
  // Those two markers are impossible in a legitimate copy (pure opaque-origin artifacts),
  // so on an exact startsWith match, swap the broken base for the real w3:// URL, keeping
  // the trailing #hash/?query the website appended. Anything else is copied through untouched.
  'var _PU=' + _pu + ';' +
  'function _fixLink(t){t=String(t);if(!_PU)return t;' +
    'if(t.indexOf("nullsrcdoc")===0)return _PU+t.slice(10);' +
    'if(t.indexOf("about:srcdoc")===0)return _PU+t.slice(12);' +
    'return t;}' +
  'function _legacyCopy(t){try{' +
    'var ta=document.createElement("textarea");ta.value=String(t);' +
    'ta.style.position="fixed";ta.style.top="-9999px";ta.setAttribute("readonly","");' +
    'document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,ta.value.length);' +
    'var ok=document.execCommand("copy");document.body.removeChild(ta);' +
    'return ok?Promise.resolve():Promise.reject(new Error("copy failed"));' +
  '}catch(e){return Promise.reject(e)}}' +
  'try{' +
    'var _nc=navigator.clipboard;' +
    'var _wt=_nc&&_nc.writeText?_nc.writeText.bind(_nc):null;' +
    'var _shim={writeText:function(t){t=_fixLink(t);' +
      'return _wt?_wt(t).catch(function(){return _legacyCopy(t)}):_legacyCopy(t);' +
    '}};' +
    'Object.defineProperty(navigator,"clipboard",{value:_shim,configurable:true});' +
  '}catch(e){}' +
  // URL constructor patch: srcdoc iframes have location.href="about:srcdoc",
  // which is not a valid base for relative URL resolution.
  'var _U=window.URL;' +
  'function PU(u,b){' +
    'if(!b||b==="about:srcdoc"||b===location.href)b="' + WEBSITE_BASE + '";' +
    'return new _U(u,b);' +
  '}' +
  'PU.createObjectURL=_U.createObjectURL.bind(_U);' +
  'PU.revokeObjectURL=_U.revokeObjectURL.bind(_U);' +
  'if(_U.canParse)PU.canParse=_U.canParse.bind(_U);' +
  'try{window.URL=PU;}catch(e){}' +
  // window.ethereum stub: relays EIP-1193 calls to parent.
  'var _cbs={};' +
  // Shared bridge: post one JSON-RPC method to the renderer and resolve when the
  // matching eth-response returns. `endpoint` is carried only for raw broadcasts (see
  // the fetch shim) so the renderer can offer to keep the website\'s chosen RPC.
  'function _send(method,params,endpoint){' +
    'return new Promise(function(res,rej){' +
      'var id=(Math.random()*1e17).toString(36);' +
      '_cbs[id]={res:res,rej:rej};' +
      'var m={type:"eth-request",id:id,method:method,params:params||[]};' +
      'if(endpoint)m.endpoint=endpoint;' +
      'window.parent.postMessage(m,"*");' +
    '});' +
  '}' +
  'var _eth={' +
    'isMetaMask:true,isVerum:true,chainId:"' + chainIdHex + '",isConnected:function(){return true;},' +
    '_handlers:{},' +
    'request:function(a){' +
      // eth_chainId is answered by the host (renderer) so it reflects the ACTIVE chain, which a
      // wallet_switchEthereumChain can change at runtime (EIP-3326); chainId below is only the initial value.
      'return _send(a.method,a.params,null);' +
    '},' +
    'enable:function(){return this.request({method:"eth_requestAccounts",params:[]});},' +
    'send:function(m,p){if(typeof m==="string")return this.request({method:m,params:p||[]});return this.request(m);},' +
    'sendAsync:function(m,cb){this.request(m).then(function(r){cb(null,{id:m.id,jsonrpc:"2.0",result:r})}).catch(function(e){cb(e,null)});},' +
    'on:function(e,fn){this._handlers[e]=this._handlers[e]||[];this._handlers[e].push(fn);},' +
    'removeListener:function(e,fn){var h=this._handlers[e];if(h)this._handlers[e]=h.filter(function(x){return x!==fn;});},' +
    'emit:function(e,d){(this._handlers[e]||[]).forEach(function(fn){fn(d);});},' +
    'disconnect:function(){window.parent.postMessage({type:"eth-disconnect"},"*");}' +
  '};' +
  'window.ethereum=_eth;' +
  // fetch shim: many websites bypass window.ethereum and POST JSON-RPC straight to a
  // hardcoded RPC (tenderly/drpc/mevblocker/…) via fetch. Those requests are blocked by
  // the sandbox CSP (default-src does not allow external connect-src), so every read
  // fails. Detect a JSON-RPC POST (single or batch) and reroute it through the same
  // verified bridge window.ethereum uses — reads go to Helios/trusted RPC per the toggle;
  // eth_sendRawTransaction carries the original endpoint so the renderer can ask the user
  // whether to keep it (MEV protection). The CSP never opens; anything not JSON-RPC-shaped
  // passes straight to native fetch untouched.
  'try{' +
    'var _nf=window.fetch?window.fetch.bind(window):null;' +
    'var _isRpc=function(o){return o&&typeof o==="object"&&typeof o.method==="string"&&/^(eth|net|web3|wallet|personal)_/.test(o.method);};' +
    'var _rpcResp=function(req,ep){var id=(req&&req.id!=null)?req.id:null;' +
      'var e=(req&&req.method==="eth_sendRawTransaction")?ep:null;' +
      'return _send(req.method,req.params||[],e).then(function(r){return{jsonrpc:"2.0",id:id,result:r};},' +
        'function(err){return{jsonrpc:"2.0",id:id,error:{code:-32603,message:String(err&&err.message||err)}};});};' +
    'window.fetch=function(input,init){' +
      'try{' +
        'var method=(init&&init.method)||(input&&typeof input!=="string"&&input.method)||"GET";' +
        'if(String(method).toUpperCase()==="POST"){' +
          'var body=(init&&init.body!=null)?init.body:null;' +
          // ethers (and other libraries that build requests as bytes) send the JSON as a
          // Uint8Array/ArrayBuffer rather than a string. Decode it so the same JSON-RPC check
          // below applies — nothing new is proxied, a bytes body that isn't JSON-RPC still
          // falls through to native fetch untouched.
          'if(body&&typeof body!=="string"&&(body instanceof ArrayBuffer||ArrayBuffer.isView(body))){' +
            'try{body=new TextDecoder().decode(body);}catch(e){}' +
          '}' +
          'if(typeof body==="string"){' +
            'var j=null;try{j=JSON.parse(body);}catch(e){}' +
            'var one=_isRpc(j);' +
            'var batch=Array.isArray(j)&&j.length>0&&j.every(_isRpc);' +
            'if(one||batch){' +
              'var ep=(typeof input==="string")?input:(input&&input.url)||"";' +
              'var pr=one?_rpcResp(j,ep):Promise.all(j.map(function(x){return _rpcResp(x,ep);}));' +
              'return pr.then(function(out){return new Response(JSON.stringify(out),{status:200,headers:{"content-type":"application/json"}});});' +
            '}' +
          '}' +
        '}' +
      '}catch(e){}' +
      'return _nf?_nf(input,init):Promise.reject(new Error("fetch unavailable"));' +
    '};' +
  '}catch(e){}' +
  // EIP-6963: announce provider so wagmi latest uses us as the injected connector.
  'var _info={uuid:"w3-verum-injected",name:"Verum",icon:"",rdns:"w3.verum"};' +
  'function _announce(){' +
    'try{window.dispatchEvent(new CustomEvent("eip6963:announceProvider",{detail:Object.freeze({info:_info,provider:_eth})}));}catch(e){}' +
  '}' +
  '_announce();' +
  'window.addEventListener("eip6963:requestProvider",_announce);' +
  'window.addEventListener("message",function(e){' +
    'if(!e.data)return;' +
    'if(e.data.type==="eth-response"){' +
      'var cb=_cbs[e.data.id];if(!cb)return;' +
      'delete _cbs[e.data.id];' +
      'if(e.data.error){var er=new Error(e.data.error);if(e.data.errorCode!=null)er.code=e.data.errorCode;cb.rej(er);}else cb.res(e.data.result);' +
      'return;' +
    '}' +
    'if(e.data.type==="wallet-event"){' +
      'if(e.data.method==="heliosReady"){' +
        'window.dispatchEvent(new Event("focus"));return;' +
      '}' +
      'var p=e.data.params;' +
      // chainChanged (EIP-1193) carries the new chain id as a hex string. chainSync updates the
      // provider's chainId without an event: the host sends it when a page (re)loads on a chain other than
      // its URL's, so a reload can't make the page believe it is back on the original one.
      'if(e.data.method==="chainChanged"||e.data.method==="chainSync"){' +
        'var c=Array.isArray(p)?p[0]:p;if(typeof c!=="string")return;' +
        'window.ethereum.chainId=c;' +
        'if(e.data.method==="chainChanged")window.ethereum.emit("chainChanged",c);' +
        'return;' +
      '}' +
      'var d=(Array.isArray(p)&&Array.isArray(p[0]))?p[0]:p;' +
      'window.ethereum.emit(e.data.method,d);' +
    '}' +
  '});' +
  // Gateway → w3:// converter. Routes a link back through verum (verified) instead of an
  // external HTTP gateway. Returns null for a normal link (opened externally). Two cases:
  //  1. A web3 NAME in the host (.eth/.wei/.gwei) — always ours, whether bare (example.wei),
  //     via .limo/.link (example.wei.limo), or via an ERC-4804 gateway (foo.eth.w3link.io).
  //  2. A raw contract ADDRESS that is the SUBDOMAIN of a dedicated ERC-4804 gateway
  //     (0xADDR[.<chain>].w4eth.io). The address must be the host label — an address in a
  //     PATH (etherscan.com/address/0x…) is NOT a gateway and is left alone.
  'function _gw2w3(u){var h=u.hostname.toLowerCase();' +
    'var tail=(u.pathname||"")+(u.search||"")+(u.hash||"");' +
    // 1. Web3 name, optionally wrapped by a gateway suffix.
    'var nm=h.match(/^(.+?\\.(?:eth|wei|gwei))(?:\\.(?:limo|link)|\\.(?:w3link|w3eth|w4eth|w3q)\\.io)?$/);' +
    'if(nm)return "w3://"+nm[1]+tail;' +
    // 2. Contract address as a dedicated-gateway subdomain (with optional .<chainId>).
    'var ca=h.match(/^(0x[0-9a-f]{40})(?:\\.(\\d+))?\\.(?:w3link|w3eth|w4eth|w3q)\\.io$/);' +
    'if(ca)return "w3://"+ca[1]+(ca[2]?":"+ca[2]:"")+tail;' +
    'return null;}' +
  // External link interceptor: open http/https links in a new tab; route w3:// links through the extension.
  // On an SVG <a>, .href is an SVGAnimatedString (not a string) — reading it directly
  // made new URL() throw, so links inside inline SVG fell through to default navigation
  // and replaced the website frame. Take the string form for both HTML and SVG anchors.
  'document.addEventListener("click",function(e){' +
    'var t=e.target;' +
    'var a=t.closest?t.closest("a"):null;' +
    'if(!a&&t.parentNode){a=t.parentNode.closest?t.parentNode.closest("a"):null;}' +
    'if(!a)return;' +
    'var h=(typeof a.href==="string")?a.href:(a.href&&a.href.baseVal)||a.getAttribute("xlink:href")||a.getAttribute("href");' +
    'if(!h)return;' +
    'try{var u=new URL(h,"' + WEBSITE_BASE + '");' +
      // Same-document hash navigation (SPA hash router). A srcdoc iframe\'s base URL is the
      // containing frame (website-sandbox.html), so <a href="#/route"> resolves to
      // website-sandbox.html#/route — a default click NAVIGATES the frame there (blank page)
      // instead of a same-document hash change. Detect a link that differs from the current
      // document only by its #fragment and apply it as a local hash change, so the website\'s
      // router reacts in place. Uses document.baseURI so it matches however the anchor resolved.
      'try{var _b=new URL(document.baseURI);var _hh=new URL(h,document.baseURI);' +
        // Same-document (origin+path+query match, fragment may differ or be empty): covers
        // <a href="#/route">, <a href="#"> and <a href=""> — all of which would otherwise
        // cross-navigate the frame to website-sandbox.html (blank). Apply as a local hash change
        // so the website\'s hash router reacts in place; an unchanged hash still re-fires
        // hashchange so re-clicking the active route re-runs the router.
        'if(_hh.origin===_b.origin&&_hh.pathname===_b.pathname&&_hh.search===_b.search){' +
          'e.preventDefault();' +
          'if(location.hash!==_hh.hash)location.hash=_hh.hash;' +
          'else window.dispatchEvent(new HashChangeEvent("hashchange"));' +
          'return;' +
        '}}catch(_e){}' +
      'if(u.hostname==="' + WEBSITE_HOST + '")return;' +
      'if(u.protocol==="w3:"){' +
        'e.preventDefault();window.parent.postMessage({type:"w3-navigate",url:h},"*");return;' +
      '}' +
      'if(u.protocol==="http:"||u.protocol==="https:"){' +
        'var gw=_gw2w3(u);' +
        // Route through verum, carrying the original gateway URL. It is used ONLY if the
        // name turns out to be an IPFS/contenthash site (which verum can\'t serve) — then
        // the renderer opens this gateway URL instead. A normal contract name loads in
        // verum and the fallback is never used.
        'if(gw){e.preventDefault();window.parent.postMessage({type:"w3-navigate",url:gw,fallback:u.href},"*");return;}' +
        'e.preventDefault();window.open(u.href,"_blank");' +
      '}' +
    '}catch(ex){}' +
  '},true);' +
  // Report presses so the host's network/account pill can close its menu (cross-frame presses are invisible to it).
  'window.addEventListener("pointerdown",function(){try{window.parent.postMessage({type:"page-press"},"*");}catch(e){}},true);' +
  // Signal to renderer that the polyfill is set up and ready for wallet events.
  'window.parent.postMessage({type:"polyfill-ready"},"*");' +
'})();<\/scr' + 'ipt>'
}

// Asset map polyfill: intercept img.src assignments made by JS and replace
// https://website.w3fs/* URLs with pre-built data: URIs from the bundle.
function makeAssetPolyfill(assetMap: Record<string, string>) {
  if (!Object.keys(assetMap).length) return ''
  const mapJson = JSON.stringify(assetMap)
  return '<scr' + 'ipt>(function(m){' +
    'function fix(n){' +
      'if(!n)return;' +
      'if(n.nodeType===1&&n.tagName==="IMG"&&m[n.src])n.src=m[n.src];' +
      'if(n.querySelectorAll){var imgs=n.querySelectorAll("img");for(var i=0;i<imgs.length;i++)fix(imgs[i]);}' +
    '}' +
    'new MutationObserver(function(muts){' +
      'for(var i=0;i<muts.length;i++){' +
        'var mut=muts[i];' +
        'if(mut.type==="childList"){for(var j=0;j<mut.addedNodes.length;j++)fix(mut.addedNodes[j]);}' +
        'else if(mut.type==="attributes"&&mut.target.tagName==="IMG")fix(mut.target);' +
      '}' +
    '}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:["src"]});' +
  '})(' + mapJson + ');<\/scr' + 'ipt>'
}

window.addEventListener('message', (event: MessageEvent<RenderMessage>) => {
  if (!event.data || event.data.type !== 'render') return

  let html = event.data.html
  const assetPolyfill = makeAssetPolyfill(event.data.assetMap || {})

  // Strip crossorigin attributes: extension-origin CORS requests are rejected by
  // servers that do not allowlist chrome-extension:// origins.
  html = html.replace(/\s+crossorigin(?:=["'][^"']*["'])?/gi, '')

  const inject = makePolyfill(event.data.chainId ?? 1, event.data.pageUrl ?? '', event.data.fragment ?? '', event.data.prefersDark === true) + assetPolyfill
  html = html.indexOf('<head>') !== -1
    ? html.replace('<head>', '<head>' + inject)
    : inject + html

  // Recreate the iframe before loading, instead of reassigning srcdoc. Reassigning
  // srcdoc on an already-loaded iframe pushes a browser session-history entry, so a
  // clear-then-render (two assignments) plus the website's own hash writes made Back
  // require several clicks to unwind invisible iframe entries. A fresh iframe's first
  // load is a REPLACEMENT (no history push), keeping Back a single click per page.
  const fresh = frame.cloneNode(false) as HTMLIFrameElement  // copies id/sandbox/allow/style
  fresh.srcdoc = html          // set BEFORE connecting so the first (and only) load is `html`
  frame.replaceWith(fresh)     // connect → first navigation = replacement, no history push
  frame = fresh
})
