import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { existsSync, mkdirSync, createReadStream, readFileSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join, extname } from 'path';
import { randomBytes, pbkdf2Sync } from 'crypto';
import Busboy from 'busboy';

// ----- Config -----
const PORT = 3001;
const UPLOAD_DIR = join(process.cwd(), 'uploads');
const FILES_DIR = join(process.cwd(), 'files');
const DATA_DIR = join(process.cwd(), 'data');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;
const TOKEN_BYTES = 32;

if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
if (!existsSync(FILES_DIR)) mkdirSync(FILES_DIR, { recursive: true });
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ----- Data Store (JSON file based) -----
function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function saveJSON(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

let users = loadJSON(join(DATA_DIR, 'users.json'), []);
let friends = loadJSON(join(DATA_DIR, 'friends.json'), []);
let messages = loadJSON(join(DATA_DIR, 'messages.json'), []);

function persistUsers() { saveJSON(join(DATA_DIR, 'users.json'), users); }
function persistFriends() { saveJSON(join(DATA_DIR, 'friends.json'), friends); }
function persistMessages() { saveJSON(join(DATA_DIR, 'messages.json'), messages); }

// In-memory indexes
const tokens = new Map();  // token -> userId
const clientMap = new Map();  // userId -> ws (only one connection per user, last wins)
const wsAuth = new Map();  // ws -> { userId, username, nickname }

function genId() {
  return Date.now().toString(36) + randomBytes(4).toString('hex');
}

function hashPassword(password, salt) {
  return pbkdf2Sync(password, salt || 'chat-salt', 10000, 64, 'sha512').toString('hex');
}

function findUserById(id) {
  return users.find(u => u.id === id) || null;
}

function findUserByUsername(username) {
  return users.find(u => u.username === username) || null;
}

function searchUsers(keyword, excludeId) {
  const kw = keyword.toLowerCase();
  return users.filter(u =>
    u.id !== excludeId &&
    (u.username.toLowerCase().includes(kw) ||
     u.nickname.toLowerCase().includes(kw))
  ).map(u => ({ id: u.id, username: u.username, nickname: u.nickname }));
}

function getFriendRelation(userId, friendId) {
  return friends.find(r =>
    (r.userId === userId && r.friendId === friendId) ||
    (r.userId === friendId && r.friendId === userId)
  ) || null;
}

function areFriends(userId, friendId) {
  const rel = getFriendRelation(userId, friendId);
  return rel && rel.status === 'accepted';
}

function getPendingRequests(userId) {
  return friends.filter(r => r.friendId === userId && r.status === 'pending');
}

function getFriendsList(userId) {
  return friends
    .filter(r => r.status === 'accepted' && (r.userId === userId || r.friendId === userId))
    .map(r => {
      const friendId = r.userId === userId ? r.friendId : r.userId;
      const friend = findUserById(friendId);
      return friend ? { id: friend.id, username: friend.username, nickname: friend.nickname } : null;
    })
    .filter(Boolean);
}

function sendToUser(userId, msg) {
  const ws = clientMap.get(userId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function getHistoryMessages(userId) {
  return messages.filter(m => m.senderId === userId || m.receiverId === userId);
}

function sendHistory(ws, userId) {
  const history = getHistoryMessages(userId);
  if (history.length > 0) {
    ws.send(JSON.stringify({ type: 'history_messages', messages: history }));
  }
}

// ----- HTTP Server -----
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve uploaded images
  if (req.method === 'GET' && req.url.startsWith('/uploads/')) {
    const filename = req.url.slice(9).split('?')[0];
    const filePath = join(UPLOAD_DIR, filename);

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const mimeTypes = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp',
    };
    const ext = extname(filename).toLowerCase();
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    createReadStream(filePath).pipe(res);
    return;
  }

  // Upload file (requires ?token=xxx)  -- must come before /upload to avoid prefix match
  if (req.method === 'POST' && req.url.startsWith('/upload-file')) {
    const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const token = urlParams.get('token');

    if (!token || !tokens.has(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请先登录' }));
      return;
    }

    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_FILE_SIZE, files: 1 } });

    busboy.on('file', async (fieldname, file, info) => {
      const { filename: originalName } = info;

      // Sanitize filename
      const safeName = originalName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');
      const savedName = genId() + '_' + safeName;
      const filePath = join(FILES_DIR, savedName);
      const chunks = [];

      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', async () => {
        const buffer = Buffer.concat(chunks);
        await writeFile(filePath, buffer);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          url: `/files/${savedName}`,
          name: originalName,
          size: buffer.length
        }));
      });
    });

    busboy.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '上传失败' }));
    });

    req.pipe(busboy);
    return;
  }

  // Upload image (requires ?token=xxx)
  if (req.method === 'POST' && req.url.startsWith('/upload')) {
    const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const token = urlParams.get('token');

    if (!token || !tokens.has(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请先登录' }));
      return;
    }

    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE, files: 1 } });

    busboy.on('file', async (fieldname, file, info) => {
      const { filename: originalName } = info;
      const ext = extname(originalName).toLowerCase();

      if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
        file.resume();
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '不支持的图片格式，支持 jpg/png/gif/webp/bmp' }));
        return;
      }

      const savedName = genId() + ext;
      const filePath = join(UPLOAD_DIR, savedName);
      const chunks = [];

      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', async () => {
        const buffer = Buffer.concat(chunks);
        await writeFile(filePath, buffer);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: `/uploads/${savedName}`, name: originalName }));
      });
    });

    busboy.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '上传失败' }));
    });

    req.pipe(busboy);
    return;
  }

  // Serve uploaded files
  if (req.method === 'GET' && req.url.startsWith('/files/')) {
    const filename = req.url.slice(7).split('?')[0];
    const filePath = join(FILES_DIR, filename);

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ----- WebSocket Server -----
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (data.type) {
      // ===== Auth =====
      case 'register': {
        const username = (data.username || '').trim();
        const password = (data.password || '').trim();
        const nickname = (data.nickname || username).trim().slice(0, 20);

        if (!username || !password) {
          ws.send(JSON.stringify({ type: 'error', text: '用户名和密码不能为空' }));
          return;
        }
        if (username.length < 3 || username.length > 20) {
          ws.send(JSON.stringify({ type: 'error', text: '用户名需要 3-20 个字符' }));
          return;
        }
        if (password.length < 4) {
          ws.send(JSON.stringify({ type: 'error', text: '密码至少 4 个字符' }));
          return;
        }
        if (findUserByUsername(username)) {
          ws.send(JSON.stringify({ type: 'error', text: '用户名已存在' }));
          return;
        }

        const user = {
          id: genId(),
          username,
          passwordHash: hashPassword(password),
          nickname,
          createdAt: Date.now()
        };
        users.push(user);
        persistUsers();

        // Auto-login
        const token = randomBytes(TOKEN_BYTES).toString('hex');
        tokens.set(token, user.id);
        userId = user.id;
        wsAuth.set(ws, { userId: user.id, username, nickname });
        clientMap.set(user.id, ws);

        ws.send(JSON.stringify({
          type: 'login_success',
          token,
          user: { id: user.id, username: user.username, nickname: user.nickname }
        }));

        // Send friends list
        sendFriendsList(ws, user.id);
        // Send history messages
        sendHistory(ws, user.id);
        break;
      }

      case 'login': {
        const username = (data.username || '').trim();
        const password = (data.password || '').trim();

        if (!username || !password) {
          ws.send(JSON.stringify({ type: 'error', text: '请输入用户名和密码' }));
          return;
        }

        const user = findUserByUsername(username);
        if (!user || user.passwordHash !== hashPassword(password)) {
          ws.send(JSON.stringify({ type: 'error', text: '用户名或密码错误' }));
          return;
        }

        const token = randomBytes(TOKEN_BYTES).toString('hex');
        tokens.set(token, user.id);
        userId = user.id;
        wsAuth.set(ws, { userId: user.id, username, nickname: user.nickname });
        clientMap.set(user.id, ws);

        ws.send(JSON.stringify({
          type: 'login_success',
          token,
          user: { id: user.id, username: user.username, nickname: user.nickname }
        }));

        sendFriendsList(ws, user.id);
        sendHistory(ws, user.id);
        break;
      }

      // ===== Friends =====
      case 'search_user': {
        if (!userId) {
          ws.send(JSON.stringify({ type: 'error', text: '请先登录' }));
          return;
        }
        const keyword = (data.keyword || '').trim();
        if (!keyword) {
          ws.send(JSON.stringify({ type: 'search_result', users: [] }));
          return;
        }
        const results = searchUsers(keyword, userId);
        ws.send(JSON.stringify({ type: 'search_result', users: results }));
        break;
      }

      case 'add_friend': {
        if (!userId) {
          ws.send(JSON.stringify({ type: 'error', text: '请先登录' }));
          return;
        }
        const friendId = data.friendId;
        if (!friendId || friendId === userId) {
          ws.send(JSON.stringify({ type: 'error', text: '无效的用户' }));
          return;
        }

        const targetUser = findUserById(friendId);
        if (!targetUser) {
          ws.send(JSON.stringify({ type: 'error', text: '用户不存在' }));
          return;
        }

        const existing = getFriendRelation(userId, friendId);
        if (existing) {
          if (existing.status === 'accepted') {
            ws.send(JSON.stringify({ type: 'error', text: '已经是好友了' }));
          } else if (existing.userId === userId) {
            ws.send(JSON.stringify({ type: 'error', text: '已发送过好友请求' }));
          } else {
            // The other side already sent a request, auto-accept
            existing.status = 'accepted';
            persistFriends();
            sendFriendsList(ws, userId);
            sendFriendsList(clientMap.get(friendId), friendId);
            sendToUser(friendId, {
              type: 'friend_accepted',
              friend: { id: findUserById(userId).id, username: findUserById(userId).username, nickname: findUserById(userId).nickname }
            });
            ws.send(JSON.stringify({
              type: 'friend_accepted',
              friend: { id: targetUser.id, username: targetUser.username, nickname: targetUser.nickname }
            }));
          }
          return;
        }

        // Create pending request
        const rel = {
          id: genId(),
          userId,
          friendId,
          status: 'pending',
          createdAt: Date.now()
        };
        friends.push(rel);
        persistFriends();

        ws.send(JSON.stringify({ type: 'friend_request_sent', to: targetUser.username }));

        // Notify target
        const sender = findUserById(userId);
        sendToUser(friendId, {
          type: 'friend_request',
          request: { id: rel.id, from: { id: sender.id, username: sender.username, nickname: sender.nickname } }
        });
        break;
      }

      case 'accept_friend': {
        if (!userId) return;
        const requestId = data.requestId;
        const rel = friends.find(r => r.id === requestId && r.friendId === userId && r.status === 'pending');
        if (!rel) {
          ws.send(JSON.stringify({ type: 'error', text: '请求不存在' }));
          return;
        }

        rel.status = 'accepted';
        persistFriends();

        sendFriendsList(ws, userId);
        sendFriendsList(clientMap.get(rel.userId), rel.userId);

        const acceptor = findUserById(userId);
        const requester = findUserById(rel.userId);

        ws.send(JSON.stringify({
          type: 'friend_accepted',
          friend: { id: requester.id, username: requester.username, nickname: requester.nickname }
        }));
        sendToUser(rel.userId, {
          type: 'friend_accepted',
          friend: { id: acceptor.id, username: acceptor.username, nickname: acceptor.nickname }
        });
        break;
      }

      case 'reject_friend': {
        if (!userId) return;
        const requestId = data.requestId;
        const idx = friends.findIndex(r => r.id === requestId && r.friendId === userId && r.status === 'pending');
        if (idx === -1) return;

        friends.splice(idx, 1);
        persistFriends();
        ws.send(JSON.stringify({ type: 'friend_request_rejected', requestId }));
        break;
      }

      case 'get_friends': {
        if (!userId) return;
        sendFriendsList(ws, userId);
        break;
      }

      // ===== Private Messaging =====
      case 'private_message': {
        if (!userId) return;
        const receiverId = data.receiverId;
        const text = (data.text || '').trim().slice(0, 500);
        if (!text || !receiverId) return;

        if (!areFriends(userId, receiverId)) {
          ws.send(JSON.stringify({ type: 'error', text: '还不是好友，无法发送消息' }));
          return;
        }

        const msg = {
          type: 'private_message',
          senderId: userId,
          receiverId,
          text,
          time: Date.now()
        };

        // Persist
        messages.push({ ...msg });
        persistMessages();

        // Send to receiver
        sendToUser(receiverId, msg);

        // Echo back to sender
        ws.send(JSON.stringify({ ...msg, echo: true }));
        break;
      }

      case 'private_image': {
        if (!userId) return;
        const receiverId = data.receiverId;
        if (!receiverId || !data.url) return;

        if (!areFriends(userId, receiverId)) {
          ws.send(JSON.stringify({ type: 'error', text: '还不是好友，无法发送消息' }));
          return;
        }

        const auth = wsAuth.get(ws);
        const msg = {
          type: 'private_image',
          senderId: userId,
          receiverId,
          nickname: auth.nickname,
          url: data.url,
          name: data.name || '',
          time: Date.now()
        };

        // Persist
        messages.push({ ...msg });
        persistMessages();

        sendToUser(receiverId, msg);
        ws.send(JSON.stringify({ ...msg, echo: true }));
        break;
      }

      case 'private_file': {
        if (!userId) return;
        const receiverId = data.receiverId;
        if (!receiverId || !data.url) return;

        if (!areFriends(userId, receiverId)) {
          ws.send(JSON.stringify({ type: 'error', text: '还不是好友，无法发送消息' }));
          return;
        }

        const auth = wsAuth.get(ws);
        const msg = {
          type: 'private_file',
          senderId: userId,
          receiverId,
          nickname: auth.nickname,
          url: data.url,
          name: data.name || '',
          size: data.size || 0,
          time: Date.now()
        };

        // Persist
        messages.push({ ...msg });
        persistMessages();

        sendToUser(receiverId, msg);
        ws.send(JSON.stringify({ ...msg, echo: true }));
        break;
      }
    }
  });

  ws.on('close', () => {
    const auth = wsAuth.get(ws);
    if (auth) {
      clientMap.delete(auth.userId);
      wsAuth.delete(ws);

      // Notify friends about offline status (optional)
      notifyFriendsStatus(auth.userId, false);
    }
  });

  ws.on('error', () => {
    const auth = wsAuth.get(ws);
    if (auth) {
      clientMap.delete(auth.userId);
      wsAuth.delete(ws);
    }
  });
});

function sendFriendsList(ws, userId) {
  const friendList = getFriendsList(userId);
  const pending = getPendingRequests(userId).map(r => {
    const sender = findUserById(r.userId);
    return {
      id: r.id,
      from: sender ? { id: sender.id, username: sender.username, nickname: sender.nickname } : null
    };
  });

  ws.send(JSON.stringify({
    type: 'friends_list',
    friends: friendList,
    requests: pending
  }));

  // Also send online statuses (all friends are "online" if they have a ws connection)
  const statuses = {};
  for (const f of friendList) {
    statuses[f.id] = clientMap.has(f.id);
  }
  ws.send(JSON.stringify({ type: 'friend_statuses', statuses }));
}

function notifyFriendsStatus(userId, online) {
  const friendList = getFriendsList(userId);
  for (const f of friendList) {
    sendToUser(f.id, { type: 'friend_status', userId, online });
  }
}

server.listen(PORT, () => {
  console.log(`Chat server running on http://localhost:${PORT}`);
  console.log(`WebSocket ready on ws://localhost:${PORT}`);
});
