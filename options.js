const els = {
  elKey: document.getElementById('elKey'),
  elVoice: document.getElementById('elVoice'),
  save: document.getElementById('save')
};

chrome.storage.sync.get(["adf_el_key","adf_el_voice"], (cfg)=>{
  if (cfg.adf_el_key) els.elKey.value = cfg.adf_el_key;
  if (cfg.adf_el_voice) els.elVoice.value = cfg.adf_el_voice;
});

els.save.addEventListener('click', ()=>{
  chrome.storage.sync.set({
    adf_el_key: els.elKey.value.trim(),
    adf_el_voice: els.elVoice.value.trim()
  }, ()=> alert("Saved!"));
});
