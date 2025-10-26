
chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if (msg.type === "PING") sendResponse({pong:true});
  return false;
});
