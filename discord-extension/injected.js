// DISCLAIMER: Use at your own risk. This script is provided as it is without warranty.
// I do not claim responsibility for any misuse or unintended consequences.

(function () {
  'use strict';

  const LOG = (...args) => console.log('%c[Discord Enhancer]', 'color:#7289da;font-weight:bold', ...args);
  LOG('Loaded.');


  function findModule(filter) {
    try {
      const chunk = window.webpackChunkdiscord_app;
      if (!chunk) return null;

      let found = null;

      chunk.push([
        [Symbol()],
        {},
        (wpRequire) => {
          const cache = wpRequire.c || {};
          for (const id in cache) {
            const mod = cache[id]?.exports;
            if (!mod) continue;
            try {
              if (filter(mod)) { found = mod; break; }
            } catch (_) {}
            try {
              if (mod.default && filter(mod.default)) { found = mod.default; break; }
            } catch (_) {}
          }
        }
      ]);
      chunk.pop();
      return found;
    } catch (e) {
      return null;
    }
  }


  function getAuthToken() {
    try {
      const mod = findModule(m => typeof m.getToken === 'function' && typeof m.getCurrentUser === 'function');
      if (mod) return mod.getToken();
    } catch (_) {}
    try {
      return JSON.parse(localStorage.getItem('token'));
    } catch (_) {}
    return null;
  }


  const messageCache = new Map();
  const MAX_CACHE = 500;

  const originalContentCache = new Map();
  const editedMessages = new Set();

  function cacheMessage(msg) {
    if (messageCache.size >= MAX_CACHE) {
      const firstKey = messageCache.keys().next().value;
      messageCache.delete(firstKey);
    }
    messageCache.set(msg.id, {
      id:         msg.id,
      channel_id: msg.channel_id,
      guild_id:   msg.guild_id,
      author:     msg.author,
      content:    msg.content,
      timestamp:  msg.timestamp,
      attachments: msg.attachments || [],
    });
  }


  const presenceStore = new Map();

  const STATUS_LABELS = {
    online:    'Online',
    idle:      'Idle',
    dnd:       'Do Not Disturb',
    offline:   'Offline',
    streaming: 'Streaming',
  };

  function updatePresence(data) {
    const userId = data.user?.id;
    if (!userId) return;

    let status = data.status || 'offline';

    const activities = data.activities || [];
    if (activities.some(a => a.type === 1)) status = 'streaming';

    presenceStore.set(userId, status);
    refreshStatusDotsForUser(userId);
  }


  const NativeWebSocket = window.WebSocket;

  class PatchedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this._de_setup();
    }

    _de_setup() {
      this.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data);
          handleGatewayPayload(payload);
        } catch (_) {}
      });
    }
  }

  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => {
    Object.defineProperty(PatchedWebSocket, k, { value: NativeWebSocket[k] });
  });

  window.WebSocket = PatchedWebSocket;
  LOG('WebSocket patched.');


  function handleGatewayPayload(payload) {
    if (payload.op !== 0 || !payload.t) return;

    switch (payload.t) {
      case 'READY':
        handleReady(payload.d);
        break;
      case 'MESSAGE_CREATE':
        cacheMessage(payload.d);
        break;
      case 'MESSAGE_UPDATE':
        handleEditedMessage(payload.d);
        break;
      case 'MESSAGE_DELETE':
        handleDeletedMessage(payload.d);
        break;
      case 'MESSAGE_DELETE_BULK':
        payload.d.ids?.forEach(id =>
          handleDeletedMessage({ id, channel_id: payload.d.channel_id, guild_id: payload.d.guild_id })
        );
        break;
      case 'PRESENCE_UPDATE':
        updatePresence(payload.d);
        break;
      case 'GUILD_MEMBERS_CHUNK':
        (payload.d.presences || []).forEach(updatePresence);
        break;
    }
  }

  function handleReady(data) {
    (data.presences || []).forEach(updatePresence);
    LOG('Ready — seeded', data.presences?.length ?? 0, 'presences.');
  }

  function handleEditedMessage(update) {
    const id = update.id;
    const newContent = update.content;
    if (!newContent) return;

    if (messageCache.has(id)) {
      const existing = messageCache.get(id);

      if (!originalContentCache.has(id)) {
        originalContentCache.set(id, existing.content ?? '');
      }

      messageCache.set(id, { ...existing, content: newContent });
    } else {
      originalContentCache.set(id, '[Original not captured — message was sent before extension loaded]');
    }

    editedMessages.add(id);
    markMessageAsEdited(id);
  }

  function markMessageAsEdited(messageId) {
    const el = findMessageElement(messageId);
    if (!el || el.dataset.deEdited) return;
    el.dataset.deEdited = 'true';
    el.dataset.deMessageId = messageId;
  }


  async function handleDeletedMessage({ id, channel_id, guild_id }) {
    const cached = messageCache.get(id);
    if (!cached) return;

    LOG('Message deleted:', id, '| author:', cached.author?.username);

    let msgEl = findMessageElement(id);

    if (msgEl) {
      applyDeletedStyling(msgEl, cached, null);
    }

    scheduleReinsert(id, channel_id, cached);

    if (guild_id) {
      try {
        const deleter = await fetchAuditLogDeleter(guild_id, channel_id, id);
        if (deleter) {
          const el = document.querySelector(`[data-de-message-id="${id}"]`);
          if (el) appendDeletedBy(el, deleter);
        }
      } catch (_) {}
    }
  }

  function findMessageElement(messageId) {
    return (
      document.querySelector(`[id*="${messageId}"]`) ||
      document.querySelector(`[data-list-item-id*="${messageId}"]`)
    );
  }

  function applyDeletedStyling(el, cached, deleter) {
    if (el.classList.contains('de-deleted-message')) return;
    el.classList.add('de-deleted-message');
    el.setAttribute('data-de-message-id', cached.id);
    el.setAttribute('data-de-deleted', 'true');

    const header = el.querySelector('[class*="username"]') ||
                   el.querySelector('[class*="header"]') ||
                   el.querySelector('h3');

    if (header) {
      const badge = document.createElement('span');
      badge.className = 'de-deleted-badge';
      badge.textContent = 'Deleted';
      header.appendChild(badge);
    }

    if (deleter) {
      appendDeletedBy(el, deleter);
    }
  }

  function appendDeletedBy(el, deleter) {
    if (el.querySelector('.de-deleted-by')) return;
    const byEl = document.createElement('div');
    byEl.className = 'de-deleted-by';
    byEl.textContent = `Deleted by ${deleter.username}${deleter.discriminator ? '#' + deleter.discriminator : ''}`;
    el.appendChild(byEl);
  }

  function scheduleReinsert(messageId, channelId, cached) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const removed of mutation.removedNodes) {
          if (!(removed instanceof HTMLElement)) continue;

          const isTarget =
            removed.id?.includes(messageId) ||
            removed.dataset?.listItemId?.includes(messageId) ||
            removed.querySelector?.(`[id*="${messageId}"]`);

          if (isTarget) {
            const targetEl = removed.id?.includes(messageId)
              ? removed
              : removed.querySelector(`[id*="${messageId}"]`);

            const elToReinsert = targetEl || removed;
            applyDeletedStyling(elToReinsert, cached, null);

            mutation.target.appendChild(elToReinsert);

            observer.disconnect();
            LOG('Re-inserted deleted message:', messageId);
            return;
          }
        }
      }
    });

    const list = document.querySelector('[class*="scrollerInner"]') ||
                 document.querySelector('ol[class*="scrollerInner"]');

    if (list) {
      observer.observe(list, { childList: true, subtree: true });
    }

    setTimeout(() => observer.disconnect(), 10_000);
  }


  async function fetchAuditLogDeleter(guildId, channelId, messageId) {
    const token = getAuthToken();
    if (!token) return null;

    try {
      const url = `https://discord.com/api/v10/guilds/${guildId}/audit-logs` +
                  `?action_type=72&limit=10`;

      const resp = await fetch(url, {
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
      });

      if (!resp.ok) return null;

      const data = await resp.json();
      const entries = data.audit_log_entries || [];

      const match = entries.find(e =>
        e.options?.channel_id === channelId &&
        Math.abs(Date.now() - snowflakeToTimestamp(e.id)) < 15_000
      );

      if (!match) return null;

      const users = data.users || [];
      const deleter = users.find(u => u.id === match.user_id);
      return deleter || { username: `<@${match.user_id}>`, discriminator: '' };
    } catch (e) {
      return null;
    }
  }

  function snowflakeToTimestamp(snowflake) {
    return Number(BigInt(snowflake) >> 22n) + 1420070400000;
  }


  let activePopup = null;

  function startContextMenuListener() {
    document.addEventListener('contextmenu', (event) => {
      const msgEl = event.target.closest('[data-de-edited="true"]') ||
                    event.target.closest('[class*="message_"][data-de-edited]');

      if (!msgEl) return;

      const messageId = msgEl.dataset.deMessageId || msgEl.dataset.deEdited;
      if (!messageId || !editedMessages.has(messageId)) return;

      waitForContextMenu(event.clientX, event.clientY, messageId);
    }, true);

    document.addEventListener('click', dismissPopup);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismissPopup(); });
  }

  function waitForContextMenu(x, y, messageId) {
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const menu = document.querySelector('[class*="menu_"][role="menu"]') ||
                   document.querySelector('[class*="contextMenu"]');

      if (menu && !menu.querySelector('.de-context-item')) {
        injectContextMenuItem(menu, messageId);
        clearInterval(poll);
      }

      if (attempts > 20) clearInterval(poll);
    }, 50);
  }

  function injectContextMenuItem(menu, messageId) {
    const separator = document.createElement('div');
    separator.className = 'de-context-separator';

    const item = document.createElement('div');
    item.className = 'de-context-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = 'Show original message';

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      showOriginalPopup(messageId);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    menu.appendChild(separator);
    menu.appendChild(item);
  }

  function showOriginalPopup(messageId) {
    dismissPopup();

    const original = originalContentCache.get(messageId);
    const current  = messageCache.get(messageId);

    const overlay = document.createElement('div');
    overlay.className = 'de-popup-overlay';
    overlay.id = 'de-original-popup';

    overlay.innerHTML = `
      <div class="de-popup">
        <div class="de-popup-header">
          <span class="de-popup-title">Original message</span>
          <button class="de-popup-close" title="Close">✕</button>
        </div>
        <div class="de-popup-section-label">Before edit</div>
        <div class="de-popup-content de-popup-original">${escapeHTML(original ?? '(not captured)')}</div>
        ${current ? `
          <div class="de-popup-section-label" style="margin-top:12px">Current</div>
          <div class="de-popup-content de-popup-current">${escapeHTML(current.content ?? '')}</div>
        ` : ''}
        <div class="de-popup-footer">Recorded by Discord Enhancer · click outside to close</div>
      </div>
    `;

    overlay.querySelector('.de-popup-close').addEventListener('click', dismissPopup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismissPopup(); });

    document.body.appendChild(overlay);
    activePopup = overlay;
  }

  function dismissPopup() {
    if (activePopup) {
      activePopup.remove();
      activePopup = null;
    }
  }

  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .replace(/\n/g, '<br>');
  }


  function getUserIdFromMessageEl(el) {
    const authorEl = el.querySelector('[class*="username"]');
    if (!authorEl) return null;

    if (el.dataset?.authorId) return el.dataset.authorId;

    const li = el.closest('li');
    if (li?.dataset?.authorId) return li.dataset.authorId;

    return null;
  }

  function injectStatusDot(messageEl, userId) {
    if (messageEl.querySelector('.de-status-dot')) return;

    const status = presenceStore.get(userId) || 'offline';
    const usernameEl = messageEl.querySelector('[class*="username_"]') ||
                       messageEl.querySelector('[class*="headerText"]');

    if (!usernameEl) return;

    const dot = document.createElement('span');
    dot.className = 'de-status-dot';
    dot.dataset.status = status;
    dot.dataset.statusLabel = STATUS_LABELS[status] || status;
    dot.title = STATUS_LABELS[status] || status;
    dot.setAttribute('data-de-user', userId);

    usernameEl.insertAdjacentElement('afterend', dot);
  }

  function refreshStatusDotsForUser(userId) {
    const status = presenceStore.get(userId) || 'offline';
    document.querySelectorAll(`.de-status-dot[data-de-user="${userId}"]`).forEach(dot => {
      dot.dataset.status = status;
      dot.dataset.statusLabel = STATUS_LABELS[status] || status;
      dot.title = STATUS_LABELS[status] || status;
    });
  }


  let domObserver = null;

  function processMessageElement(el) {
    const authorId =
      el.dataset?.authorId ||
      el.closest('li')?.dataset?.authorId ||
      el.querySelector('[data-author-id]')?.dataset?.authorId;

    if (authorId) {
      injectStatusDot(el, authorId);
    } else {
      inferUserIdAndInject(el);
    }
  }

  function inferUserIdAndInject(msgEl) {
    const usernameEl = msgEl.querySelector('[class*="username_"]');
    if (!usernameEl) return;
    const name = usernameEl.textContent?.trim();
    if (!name) return;

    for (const [, msg] of messageCache) {
      if (msg.author?.username === name || msg.author?.global_name === name) {
        injectStatusDot(msgEl, msg.author.id);
        return;
      }
    }
  }

  function startDOMObserver() {
    if (domObserver) domObserver.disconnect();

    domObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;

          if (node.matches?.('[class*="message_"]') || node.matches?.('[class*="messageListItem"]')) {
            processMessageElement(node);
          } else {
            node.querySelectorAll?.('[class*="message_"]').forEach(processMessageElement);
          }
        }
      }
    });

    domObserver.observe(document.body, { childList: true, subtree: true });
    LOG('DOM observer started.');

    document.querySelectorAll('[class*="message_"]').forEach(processMessageElement);
  }


  function waitForDiscord() {
    const interval = setInterval(() => {
      const app = document.querySelector('#app-mount');
      if (app && window.webpackChunkdiscord_app) {
        clearInterval(interval);
        LOG('Discord app detected — starting.');
        startDOMObserver();
        startContextMenuListener();
      }
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForDiscord);
  } else {
    waitForDiscord();
  }

})();
