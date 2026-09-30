/** Share only the public-to-the-authenticated-page plugin graph feed, never RPC/session streams. */
export const harnessSharedEventsBootstrap = `<script data-space-harness-shared-events>(function(){
  const NativeEventSource=window.EventSource;
  let owner;
  try { owner=window.parent; if(owner===window || owner.location.origin!==window.location.origin || !owner.EventSource)return; } catch { return; }
  if(typeof NativeEventSource!=="function")return;
  const key="__spaceHarnessPluginEventsV1";
  const clients=new Set();
  class SharedPluginEvents extends EventTarget {
    constructor(url,options){
      super();
      const resolved=new URL(url,window.location.href);
      if(resolved.origin!==window.location.origin || resolved.pathname!=="/plugins/events" || resolved.search || resolved.hash || options?.withCredentials)
        return new NativeEventSource(url,options);
      let hub=owner[key];
      if(!hub){
        hub={source:null,clients:new Set(),ownerClient:null};
        owner[key]=hub;
      }
      this.hub=hub;this.url=resolved.href;this.withCredentials=false;this.closed=false;
      this.onopen=null;this.onmessage=null;this.onerror=null;
      hub.clients.add(this);clients.add(this);
      if(!hub.ownerClient)this.takeOwnership();
      if(hub.source.readyState===1)queueMicrotask(()=>{if(!this.closed)this.deliver("open",{});});
    }
    get readyState(){return this.closed?2:this.hub.source.readyState;}
    takeOwnership(){
      const hub=this.hub;
      hub.source?.close();
      hub.ownerClient=this;
      const source=new owner.EventSource(this.url);
      hub.source=source;
      for(const type of ["open","message","error"])source.addEventListener(type,event=>{
        if(hub.source!==source)return;
        for(const client of Array.from(hub.clients))client.deliver(type,event);
      });
    }
    deliver(type,event){
      if(this.closed)return;
      const copy=type==="message"?new MessageEvent(type,{data:event.data,origin:event.origin,lastEventId:event.lastEventId}):new Event(type);
      this.dispatchEvent(copy);
      const handler=this["on"+type];if(typeof handler==="function")handler.call(this,copy);
    }
    close(){
      if(this.closed)return;this.closed=true;
      clients.delete(this);this.hub.clients.delete(this);
      if(this.hub.clients.size===0){this.hub.source.close();if(owner[key]===this.hub)delete owner[key];}
      else if(this.hub.ownerClient===this)this.hub.clients.values().next().value.takeOwnership();
    }
  }
  for(const [name,value] of [["CONNECTING",0],["OPEN",1],["CLOSED",2]]){
    Object.defineProperty(SharedPluginEvents,name,{value});Object.defineProperty(SharedPluginEvents.prototype,name,{value});
  }
  window.EventSource=SharedPluginEvents;
  window.addEventListener("pagehide",()=>{for(const client of Array.from(clients))client.close();});
})();</script>`;
