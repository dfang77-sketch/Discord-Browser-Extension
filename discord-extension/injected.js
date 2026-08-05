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


  let _discordPresenceStore = null;

  function getDiscordPresenceStore() {
    if (_discordPresenceStore) return _discordPresenceStore;
    _discordPresenceStore = findModule(
      m => typeof m.getStatus === 'function' &&
           typeof m.getUserActivities === 'function' &&
           typeof m.isMobileOnline === 'function'
    );
    return _discordPresenceStore;
  }

  function getStatusForUser(userId) {
    const local = presenceStore.get(userId);
    if (local) return local;
    try {
      const store = getDiscordPresenceStore();
      if (store) {
        const raw = store.getStatus(userId);
        if (typeof raw === 'string' && raw) return raw;
        if (raw && typeof raw === 'object') {
          const s = raw.status;
          if (typeof s === 'string' && s) return s;
        }
      }
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

    const ownId = data.user?.id;
    if (ownId && data.sessions?.length) {
      const priority = { online: 4, streaming: 3, idle: 2, dnd: 1, offline: 0 };
      let best = 'offline';
      for (const s of data.sessions) {
        const st = s.status || 'offline';
        if ((priority[st] ?? 0) > (priority[best] ?? 0)) best = st;
      }
      presenceStore.set(ownId, best);
      LOG('Own presence seeded:', best);
    }

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

    showDeletedToast(cached);

    if (guild_id) {
      try {
        const deleter = await fetchAuditLogDeleter(guild_id, channel_id, id);
        if (deleter) updateDeletedToast(id, deleter);
      } catch (_) {}
    }
  }

  function showDeletedToast(cached) {
    let container = document.getElementById('de-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'de-toast-container';
      document.body.appendChild(container);
    }

    const author = cached.author?.global_name || cached.author?.username || 'Unknown';
    const content = cached.content || '(no text content)';
    const extra = cached.attachments?.length
      ? ` [+${cached.attachments.length} attachment(s)]` : '';

    const toast = document.createElement('div');
    toast.className = 'de-toast';
    toast.dataset.deToastId = cached.id;
    toast.innerHTML = `
      <div class="de-toast-header">
        <span class="de-toast-badge">Deleted</span>
        <span class="de-toast-author">${escapeHTML(author)}</span>
        <button class="de-toast-close" title="Dismiss">✕</button>
      </div>
      <div class="de-toast-content">${escapeHTML(content + extra)}</div>
      <div class="de-toast-by"></div>
    `;

    toast.querySelector('.de-toast-close').addEventListener('click', () => {
      toast.classList.add('de-toast-fade');
      setTimeout(() => toast.remove(), 350);
    });

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('de-toast-fade');
      setTimeout(() => toast.remove(), 350);
    }, 12000);
  }

  function updateDeletedToast(messageId, deleter) {
    const toast = document.querySelector(`[data-de-toast-id="${messageId}"]`);
    if (!toast) return;
    const byEl = toast.querySelector('.de-toast-by');
    if (byEl) {
      byEl.textContent = `Deleted by ${deleter.username}${deleter.discriminator ? '#' + deleter.discriminator : ''}`;
    }
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

  function findMessageElement(messageId) {
    return (
      document.querySelector(`[id*="${messageId}"]`) ||
      document.querySelector(`[data-list-item-id*="${messageId}"]`)
    );
  }


  let activePopup = null;

  function startContextMenuListener() {
    document.addEventListener('contextmenu', (event) => {
      let el = event.target;
      let messageId = null;

      while (el && el !== document.body) {
        if (el.id?.startsWith('chat-messages-')) {
          const parts = el.id.split('-');
          messageId = parts[parts.length - 1];
          break;
        }
        if (el.dataset?.listItemId?.startsWith('chat-messages-')) {
          const parts = el.dataset.listItemId.split('-');
          messageId = parts[parts.length - 1];
          break;
        }
        el = el.parentElement;
      }

      if (!messageId || !editedMessages.has(messageId)) return;

      waitForContextMenu(messageId);
    }, true);

    document.addEventListener('click', dismissPopup);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismissPopup(); });
  }

  function waitForContextMenu(messageId) {
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const menu = document.querySelector('[role="menu"]');

      if (menu && !menu.querySelector('.de-context-item')) {
        injectContextMenuItem(menu, messageId);
        clearInterval(poll);
      }

      if (attempts > 30) clearInterval(poll);
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


  function getUserIdFromAvatar(el) {
    const img =
      el.querySelector('img[src*="cdn.discordapp.com/avatars/"]') ||
      el.closest('li')?.querySelector('img[src*="cdn.discordapp.com/avatars/"]');
    if (!img) return null;
    const match = img.src.match(/\/avatars\/(\d+)\//);
    return match ? match[1] : null;
  }

  function processMessageElement(el) {
    const authorId =
      el.dataset?.authorId ||
      el.closest('li')?.dataset?.authorId ||
      el.querySelector('[data-author-id]')?.dataset?.authorId;

    if (authorId) {
      injectStatusDot(el, authorId);
      return;
    }

    const avatarUserId = getUserIdFromAvatar(el);
    if (avatarUserId) {
      injectStatusDot(el, avatarUserId);
      return;
    }

    const li = el.closest('li') || el;
    const rawId = li.id || li.dataset?.listItemId;
    if (rawId) {
      const parts = rawId.split('-');
      const msgId = parts[parts.length - 1];
      if (msgId && messageCache.has(msgId)) {
        injectStatusDot(el, messageCache.get(msgId).author.id);
        return;
      }
    }

    inferUserIdAndInject(el);
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

  function injectStatusDot(messageEl, userId) {
    if (messageEl.querySelector('.de-status-dot')) return;

    const status = getStatusForUser(userId);
    if (!status) return;

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
    const status = getStatusForUser(userId);
    if (!status) return;
    document.querySelectorAll(`.de-status-dot[data-de-user="${userId}"]`).forEach(dot => {
      dot.dataset.status = status;
      dot.dataset.statusLabel = STATUS_LABELS[status] || status;
      dot.title = STATUS_LABELS[status] || status;
    });
  }


  let domObserver = null;

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
