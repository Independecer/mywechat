// ===== State =====
let ws;
let token;
let currentUser = null;
let friends = [];
let requests = [];
let friendStatuses = {};
let activeChat = null;
let chatCache = new Map(); // friendId -> messages[]
const API_HOST = window.API_HOST || '';

// ===== DOM refs =====
const $ = (id) => document.getElementById(id);

const authOverlay = $('auth-overlay');
const authUsername = $('auth-username');
const authPassword = $('auth-password');
const authLoginBtn = $('auth-login-btn');
const authRegisterBtn = $('auth-register-btn');
const authError = $('auth-error');

const mainLayout = $('main-layout');
const currentUserName = $('current-user-name');
const logoutBtn = $('logout-btn');

const searchInput = $('search-input');
const searchResults = $('search-results');
const requestsArea = $('requests-area');
const requestsList = $('requests-list');
const friendsList = $('friends-list');

const chatPlaceholder = $('chat-placeholder');
const chatContent = $('chat-content');
const chatFriendName = $('chat-friend-name');
const chatFriendStatus = $('chat-friend-status');
const chatMessages = $('chat-messages');
const chatMsgInput = $('chat-msg-input');
const chatSendBtn = $('chat-send-btn');
const chatImgBtn = $('chat-img-btn');
const chatImgInput = $('chat-img-input');
const chatFileBtn = $('chat-file-btn');
const chatFileInput = $('chat-file-input');
const chatBackBtn = $('chat-back-btn');

// ===== WebSocket =====
function connectWS() {
  let wsUrl;
  if (API_HOST) {
    const wsProtocol = API_HOST.startsWith('https') ? 'wss:' : 'ws:';
    wsUrl = `${wsProtocol}//${API_HOST.replace(/^https?:\/\//, '')}/ws`;
  } else {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${protocol}//${location.host}/ws`;
  }
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    // Auto-login with stored token
    const saved = loadSession();
    if (saved) {
      ws.send(JSON.stringify({ type: 'login', username: saved.username, password: saved.password }));
    } else {
      showAuth();
    }
  };

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    handleWS(data);
  };

  ws.onclose = () => {
    addSystemMsgToActive('连接断开，重连中...');
    setTimeout(connectWS, 3000);
  };
}

function handleWS(data) {
  switch (data.type) {
    case 'error':
      if (data.text.includes('用户名或密码错误') || data.text.includes('已存在')) {
        authError.textContent = data.text;
      }
      break;

    case 'login_success':
      token = data.token;
      currentUser = data.user;
      saveSession();
      hideAuth();
      break;

    case 'friends_list':
      friends = data.friends;
      requests = data.requests;
      renderFriendsList();
      renderRequests();
      break;

    case 'friend_request':
      requests.push(data.request);
      renderRequests();
      break;

    case 'friend_accepted':
      friends.push(data.friend);
      requests = requests.filter(r => r.from.id !== data.friend.id);
      renderFriendsList();
      renderRequests();
      break;

    case 'friend_request_sent':
      break;

    case 'friend_request_rejected':
      requests = requests.filter(r => r.id !== data.requestId);
      renderRequests();
      break;

    case 'friend_status':
      friendStatuses[data.userId] = data.online;
      updateFriendStatus(data.userId, data.online);
      if (activeChat === data.userId) {
        chatFriendStatus.textContent = data.online ? '在线' : '离线';
      }
      break;

    case 'friend_statuses':
      friendStatuses = data.statuses;
      for (const [fid, online] of Object.entries(data.statuses)) {
        updateFriendStatus(fid, online);
      }
      break;

    case 'search_result':
      renderSearchResults(data.users);
      break;

    case 'private_message': {
      const friendId = data.echo ? data.receiverId : data.senderId;
      cacheMessage(friendId, { type: 'text', mine: data.echo || false, text: data.text, time: data.time });
      if (activeChat === friendId) renderActiveChat();
      updateFriendLastMsg(friendId, data.text);
      break;
    }

    case 'private_image': {
      const friendId = data.echo ? data.receiverId : data.senderId;
      cacheMessage(friendId, { type: 'image', mine: data.echo || false, url: data.url, name: data.name, time: data.time });
      if (activeChat === friendId) renderActiveChat();
      updateFriendLastMsg(friendId, '[图片]');
      break;
    }

    case 'private_file': {
      const friendId = data.echo ? data.receiverId : data.senderId;
      cacheMessage(friendId, { type: 'file', mine: data.echo || false, url: data.url, name: data.name, size: data.size, time: data.time });
      if (activeChat === friendId) renderActiveChat();
      updateFriendLastMsg(friendId, '[文件] ' + data.name);
      break;
    }

    case 'history_messages': {
      for (const m of data.messages) {
        const isMine = m.senderId === currentUser.id;
        const friendId = isMine ? m.receiverId : m.senderId;
        let msg;
        if (m.type === 'private_message') {
          msg = { type: 'text', mine: isMine, text: m.text, time: m.time };
        } else if (m.type === 'private_file') {
          msg = { type: 'file', mine: isMine, url: m.url, name: m.name, size: m.size, time: m.time };
        } else {
          msg = { type: 'image', mine: isMine, url: m.url, name: m.name, time: m.time };
        }
        cacheMessage(friendId, msg);
        if (msg.type === 'text') {
          updateFriendLastMsg(friendId, m.text);
        } else if (msg.type === 'file') {
          updateFriendLastMsg(friendId, '[文件] ' + (m.name || ''));
        } else {
          updateFriendLastMsg(friendId, '[图片]');
        }
      }
      break;
    }
  }
}

// ===== Auth =====
function showAuth() {
  authOverlay.style.display = 'flex';
  mainLayout.style.display = 'none';
  authError.textContent = '';
  authUsername.value = '';
  authPassword.value = '';
  authUsername.focus();
}

function hideAuth() {
  authOverlay.style.display = 'none';
  mainLayout.style.display = 'flex';
  currentUserName.textContent = currentUser.nickname;
}

function doAuth(isRegister) {
  const username = authUsername.value.trim();
  const password = authPassword.value.trim();

  if (!username || !password) {
    authError.textContent = '请输入用户名和密码';
    return;
  }
  if (username.length < 3) {
    authError.textContent = '用户名至少 3 个字符';
    return;
  }
  if (password.length < 4) {
    authError.textContent = '密码至少 4 个字符';
    return;
  }

  authError.textContent = '';
  authLoginBtn.disabled = true;
  authRegisterBtn.disabled = true;

  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: isRegister ? 'register' : 'login', username, password }));
  } else {
    // Wait for open, then retry
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: isRegister ? 'register' : 'login', username, password }));
    }, { once: true });
  }

  setTimeout(() => {
    authLoginBtn.disabled = false;
    authRegisterBtn.disabled = false;
  }, 3000);
}

authLoginBtn.addEventListener('click', () => doAuth(false));
authRegisterBtn.addEventListener('click', () => doAuth(true));

authUsername.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') authPassword.focus();
});
authPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doAuth(false);
});

logoutBtn.addEventListener('click', () => {
  clearSession();
  ws.close();
  currentUser = null;
  token = null;
  friends = [];
  requests = [];
  activeChat = null;
  chatCache.clear();
  showAuth();
});

// ===== Session persistence =====
function saveSession() {
  localStorage.setItem('chat_user', JSON.stringify({
    username: currentUser.username,
    password: authPassword.value
  }));
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem('chat_user'));
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem('chat_user');
}

// ===== Friends =====
function renderFriendsList() {
  friendsList.innerHTML = friends.map(f => `
    <div class="friend-item ${activeChat === f.id ? 'active' : ''}" data-id="${f.id}">
      <div class="avatar">${escapeHtml(f.nickname[0] || '?')}</div>
      <div class="info">
        <div class="nickname">${escapeHtml(f.nickname)}</div>
        <div class="last-msg" id="last-msg-${f.id}"></div>
      </div>
      <div class="status-dot ${friendStatuses[f.id] ? 'online' : 'offline'}" id="status-${f.id}"></div>
    </div>
  `).join('');

  friendsList.querySelectorAll('.friend-item').forEach(el => {
    el.addEventListener('click', () => openChat(el.dataset.id));
  });
}

function updateFriendStatus(friendId, online) {
  const dot = document.getElementById(`status-${friendId}`);
  if (dot) {
    dot.className = `status-dot ${online ? 'online' : 'offline'}`;
  }
}

function updateFriendLastMsg(friendId, text) {
  const el = document.getElementById(`last-msg-${friendId}`);
  if (el) el.textContent = text.slice(0, 30);
}

function renderRequests() {
  if (requests.length === 0) {
    requestsArea.style.display = 'none';
    return;
  }
  requestsArea.style.display = 'block';
  requestsList.innerHTML = requests.map(r => `
    <div class="request-item">
      <span class="info">${escapeHtml(r.from.nickname)} (${escapeHtml(r.from.username)})</span>
      <div class="actions">
        <button class="accept-btn" data-id="${r.id}">接受</button>
        <button class="reject-btn" data-id="${r.id}">拒绝</button>
      </div>
    </div>
  `).join('');

  requestsList.querySelectorAll('.accept-btn').forEach(btn => {
    btn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'accept_friend', requestId: btn.dataset.id })));
  });
  requestsList.querySelectorAll('.reject-btn').forEach(btn => {
    btn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'reject_friend', requestId: btn.dataset.id })));
  });
}

// ===== Search =====
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const val = searchInput.value.trim();
  if (!val) {
    searchResults.classList.remove('show');
    return;
  }
  searchTimer = setTimeout(() => {
    ws.send(JSON.stringify({ type: 'search_user', keyword: val }));
  }, 300);
});

searchInput.addEventListener('blur', () => {
  setTimeout(() => searchResults.classList.remove('show'), 200);
});

searchInput.addEventListener('focus', () => {
  if (searchResults.children.length > 0) searchResults.classList.add('show');
});

function renderSearchResults(users) {
  if (users.length === 0) {
    searchResults.innerHTML = '<div class="search-result-item" style="color:#888">未找到用户</div>';
  } else {
    searchResults.innerHTML = users.map(u => `
      <div class="search-result-item">
        <div class="info">
          <div class="nickname">${escapeHtml(u.nickname)}</div>
          <div class="username">@${escapeHtml(u.username)}</div>
        </div>
        <button class="add-btn" data-id="${u.id}">添加</button>
      </div>
    `).join('');

    searchResults.querySelectorAll('.add-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'add_friend', friendId: btn.dataset.id }));
        btn.textContent = '已发送';
        btn.disabled = true;
      });
    });
  }
  searchResults.classList.add('show');
}

// ===== Chat =====
const isMobile = () => window.innerWidth <= 768;

function openChat(friendId) {
  activeChat = friendId;
  chatPlaceholder.style.display = 'none';
  chatContent.style.display = 'flex';

  const friend = friends.find(f => f.id === friendId);
  if (friend) {
    chatFriendName.textContent = friend.nickname;
    chatFriendStatus.textContent = friendStatuses[friendId] ? '在线' : '离线';
  }

  if (!chatCache.has(friendId)) chatCache.set(friendId, []);
  renderActiveChat();
  renderFriendsList();
  chatMsgInput.focus();

  // Mobile: show chat view
  if (isMobile()) {
    mainLayout.classList.add('show-chat');
    chatBackBtn.style.display = 'inline-block';
  }
}

function closeChatMobile() {
  activeChat = null;
  chatContent.style.display = 'none';
  chatPlaceholder.style.display = 'flex';
  if (isMobile()) {
    mainLayout.classList.remove('show-chat');
    chatBackBtn.style.display = 'none';
  }
}

chatBackBtn.addEventListener('click', () => closeChatMobile());

function cacheMessage(friendId, msg) {
  if (!chatCache.has(friendId)) chatCache.set(friendId, []);
  chatCache.get(friendId).push(msg);
}

function renderActiveChat() {
  if (!activeChat) return;
  const msgs = chatCache.get(activeChat) || [];
  chatMessages.innerHTML = msgs.map(m => {
    const cls = m.mine ? 'mine' : 'theirs';
    const time = new Date(m.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    if (m.type === 'image') {
      return `
        <div class="msg-bubble ${cls} msg-image">
          <img src="${escapeHtml(m.url)}" alt="${escapeHtml(m.name)}" loading="lazy" />
          <div class="time">${time}</div>
        </div>
      `;
    }
    if (m.type === 'file') {
      const fileSize = formatFileSize(m.size || 0);
      return `
        <div class="msg-bubble ${cls} msg-file">
          <div class="file-card">
            <div class="file-icon">&#128196;</div>
            <div class="file-detail">
              <div class="file-name">${escapeHtml(m.name)}</div>
              <div class="file-size">${fileSize}</div>
              <a class="file-download" href="${escapeHtml(m.url)}" download="${escapeHtml(m.name)}">下载</a>
            </div>
          </div>
          <div class="time">${time}</div>
        </div>
      `;
    }
    return `
      <div class="msg-bubble ${cls}">
        <div class="text">${escapeHtml(m.text)}</div>
        <div class="time">${time}</div>
      </div>
    `;
  }).join('');

  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Click image to view full
  chatMessages.querySelectorAll('img').forEach(img => {
    img.addEventListener('click', () => window.open(img.src, '_blank'));
  });
}

function addSystemMsgToActive(text) {
  if (!activeChat || !chatContent.style.display || chatContent.style.display === 'none') return;
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendMessage() {
  if (!activeChat) return;
  const text = chatMsgInput.value.trim();
  if (!text) return;
  ws.send(JSON.stringify({ type: 'private_message', receiverId: activeChat, text }));
  chatMsgInput.value = '';
}

chatSendBtn.addEventListener('click', sendMessage);
chatMsgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// Image upload
chatImgBtn.addEventListener('click', () => chatImgInput.click());

chatImgInput.addEventListener('change', async () => {
  const file = chatImgInput.files[0];
  if (!file || !activeChat) return;

  if (file.size > 10 * 1024 * 1024) {
    addSystemMsgToActive('图片不能超过 10MB');
    chatImgInput.value = '';
    return;
  }

  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
  if (!allowed.includes(file.type)) {
    addSystemMsgToActive('不支持该图片格式');
    chatImgInput.value = '';
    return;
  }

  chatImgBtn.disabled = true;
  chatImgBtn.textContent = '...';

  try {
    const formData = new FormData();
    formData.append('image', file);

    const res = await fetch(`${API_HOST}/upload?token=${token}`, { method: 'POST', body: formData });
    const result = await res.json();

    if (res.ok) {
      ws.send(JSON.stringify({ type: 'private_image', receiverId: activeChat, url: result.url, name: result.name }));
    } else {
      addSystemMsgToActive(result.error || '上传失败');
    }
  } catch {
    addSystemMsgToActive('图片上传失败');
  } finally {
    chatImgBtn.disabled = false;
    chatImgBtn.textContent = '图片';
    chatImgInput.value = '';
  }
});

// File upload
chatFileBtn.addEventListener('click', () => chatFileInput.click());

chatFileInput.addEventListener('change', async () => {
  const file = chatFileInput.files[0];
  if (!file || !activeChat) return;

  if (file.size > 50 * 1024 * 1024) {
    addSystemMsgToActive('文件不能超过 50MB');
    chatFileInput.value = '';
    return;
  }

  chatFileBtn.disabled = true;
  chatFileBtn.textContent = '...';

  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`${API_HOST}/upload-file?token=${token}`, { method: 'POST', body: formData });
    const result = await res.json();

    if (res.ok) {
      ws.send(JSON.stringify({
        type: 'private_file',
        receiverId: activeChat,
        url: result.url,
        name: result.name,
        size: result.size
      }));
    } else {
      addSystemMsgToActive(result.error || '上传失败');
    }
  } catch {
    addSystemMsgToActive('文件上传失败');
  } finally {
    chatFileBtn.disabled = false;
    chatFileBtn.textContent = '文件';
    chatFileInput.value = '';
  }
});

// ===== Helpers =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ===== Init =====
connectWS();
