document.getElementById('open-options').addEventListener('click', (e)=>{
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

const els = {
  wpm: document.getElementById('wpm'),
  charcap: document.getElementById('charcap'),
  start: document.getElementById('start')
};

// restore
chrome.storage.sync.get(["adf_wpm","adf_charcap"], (cfg)=>{
  if (cfg.adf_wpm) els.wpm.value = cfg.adf_wpm;
  if (cfg.adf_charcap) els.charcap.value = cfg.adf_charcap;
});

els.start.addEventListener('click', async ()=>{
  const wpm = parseInt(els.wpm.value || "220", 10);
  const charcap = parseInt(els.charcap.value || "4000", 10);
  chrome.storage.sync.set({ adf_wpm:wpm, adf_charcap:charcap });

  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  const url = tab?.url || "";
  if (!/^https?:\/\//i.test(url)) {
    alert("Please run this on a normal web page (http/https), not a Chrome page.");
    return;
  }

  // ensure content script is present
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] });
  } catch(_) {}

  // extract
  let payload;
  try {
    payload = await chrome.tabs.sendMessage(tab.id, { type:"EXTRACT_FULL", cap: charcap });
  } catch (e) {
    console.error("Extraction error:", e);
    alert("Could not extract text from this page. Try a different article (e.g., Wikipedia).");
    return;
  }
  if (!payload || !payload.text || payload.text.trim().length < 50) {
    alert("No readable text was extracted from this page. Try a different article.");
    return;
  }

  // stash payload
  await chrome.storage.local.set({ adf_reader_payload: payload });

   // open reader (provider is fixed to elevenlabs)
  const readerUrl = chrome.runtime.getURL("src/reader.html");
  const params = new URLSearchParams({ provider: "elevenlabs", wpm });

  // Phone-like portrait window (~18:9)
  const win = await chrome.windows.create({
    url: `${readerUrl}?${params}`,
    type: "popup",
    width: 450,
    height: 900,
    focused: true
  });

  // (Optional) park it near the right edge of the primary display
  try {
    const left = Math.max(0, (window.screen.availWidth || 1280) - (450 + 20)); // 20px margin
    await chrome.windows.update(win.id, { left, top: 60 });
  } catch (e) {
    console.warn("Window position update failed (safe to ignore):", e);
  }
});

