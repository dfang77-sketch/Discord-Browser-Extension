(function () {
  'use strict';

 
  const url = chrome.runtime.getURL('injected.js');
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false); 
  xhr.send();

  const script = document.createElement('script');
  script.textContent = xhr.responseText;
  (document.head || document.documentElement).appendChild(script);
  script.remove();

 
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'discord-enhancer') return; 
  });
})();
