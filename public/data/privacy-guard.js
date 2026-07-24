// Privacy Guard — injected into proxied pages by the service worker.
// Prevents websites from detecting user behavior (tab switches, focus loss,
// clipboard access, mouse leave). Adapted from darksomaX/freecanvashack.
//
// This runs at the very top of <head> before any page scripts execute.
(function(){
if(document.documentElement.dataset.luxPG==='active') return;

// ── Visibility & Focus Overrides ──
Object.defineProperty(document,'visibilityState',{value:'visible',writable:true,configurable:true});
Object.defineProperty(document,'hidden',{value:false,writable:true,configurable:true});
Object.defineProperty(document,'webkitVisibilityState',{value:'visible',writable:true,configurable:true});
Object.defineProperty(document,'webkitHidden',{value:false,writable:true,configurable:true});
try{Document.prototype.hasFocus=function(){return true};}catch(e){}

// ── Blocked Event Types ──
var BLOCKED=new Set([
  'focus','focusin','focusout','blur',
  'visibilitychange','webkitvisibilitychange','mozvisibilitychange','msvisibilitychange',
  'pagehide','pageshow',
  'paste','copy','cut',
  'freeze','resume'
]);
var DOC_BLOCKED=new Set(['mouseleave','mouseenter','mouseout']);

// ── Save natives ──
var _add=EventTarget.prototype.addEventListener;
var _rem=EventTarget.prototype.removeEventListener;
var _dis=EventTarget.prototype.dispatchEvent;

// ── Patch prototypes ──
EventTarget.prototype.addEventListener=function(t,f,o){
  if(typeof t==='string'&&BLOCKED.has(t))return this;
  return _add.call(this,t,f,o);
};
EventTarget.prototype.removeEventListener=function(t,f,o){
  if(typeof t==='string'&&BLOCKED.has(t))return this;
  return _rem.call(this,t,f,o);
};
EventTarget.prototype.dispatchEvent=function(e){
  if(e&&typeof e.type==='string'&&BLOCKED.has(e.type))return true;
  return _dis.call(this,e);
};

// Patch Document/Window/Element if they have own copies
[Document,Window,Element].forEach(function(c){
  try{
    var d=Object.getOwnPropertyDescriptor(c.prototype,'addEventListener');
    if(d&&d.value&&d.value!==EventTarget.prototype.addEventListener)
      c.prototype.addEventListener=EventTarget.prototype.addEventListener;
    var r=Object.getOwnPropertyDescriptor(c.prototype,'removeEventListener');
    if(r&&r.value&&r.value!==EventTarget.prototype.removeEventListener)
      c.prototype.removeEventListener=EventTarget.prototype.removeEventListener;
  }catch(e){}
});

// Patch document & window instances (block DOC_BLOCKED too)
var _all=new Set([...BLOCKED,...DOC_BLOCKED]);
var _da=document.addEventListener.bind(document);
var _dr=document.removeEventListener.bind(document);
document.addEventListener=function(t,f,o){if(typeof t==='string'&&_all.has(t))return;return _da(t,f,o);};
document.removeEventListener=function(t,f,o){if(typeof t==='string'&&_all.has(t))return;return _dr(t,f,o);};
var _wa=window.addEventListener.bind(window);
var _wr=window.removeEventListener.bind(window);
window.addEventListener=function(t,f,o){if(typeof t==='string'&&_all.has(t))return;return _wa(t,f,o);};
window.removeEventListener=function(t,f,o){if(typeof t==='string'&&_all.has(t))return;return _wr(t,f,o);};

document.documentElement.dataset.luxPG='active';
})();
