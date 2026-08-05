

(function () {
  'use strict';

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.type = 'text/javascript';
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data?.source === 'discord-enhancer') return;
  });
})();
