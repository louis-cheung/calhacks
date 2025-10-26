try { console.log("[AdFocus] content.js injected on", location.href); } catch(e){}

function extractFullText(charCap){
  const wikiMain = document.querySelector('#mw-content-text');
  const main = wikiMain || document.querySelector('main') || document.body;
  const ps = Array.from(main.querySelectorAll('p, article p, section p'));
  let text = ps.map(p => (p.innerText || "").trim()).filter(t => t && t.length > 40).join("\n\n");
  if (!text || text.length < 500) {
    text = ((document.body.innerText || document.documentElement.innerText) || "").trim();
  }
  text = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (charCap && text.length > charCap) text = text.slice(0, charCap);
  return { url: location.href, title: document.title, text };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if (msg.type === "EXTRACT_FULL") {
    const cap = msg.cap || 4000;
    sendResponse(extractFullText(cap));
  }
});
