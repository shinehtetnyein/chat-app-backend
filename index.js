require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios'); // Added for making HTTP requests to Google API
const uploadRoutes = require('./src/routes/upload.routes');
const { initSocket } = require('./src/sockets');
const prisma = require('./src/prisma/client');
const { getUserSockets, getOnlineUserIds, isOnline } = require('./src/services/presence.service');

const app = express();
app.set('trust proxy', 1);
const path = require('path');
const fs = require('fs');

const getGoogleRedirectUri = (req) => {
  const host = req.get('host') || 'localhost:5000';
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isLocal ? 'http' : 'https';
  return `${protocol}://${host}/api/auth/google/callback`;
};

const clientUrls = (process.env.CLIENT_URL || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);

const JWT_SECRET = process.env.JWT_SECRET || 'MvPdqDWDPgYS4gkAYq0yDL+mI+e1AQwDaS0Rq+meI/A=';

// Ensure you have these values in your .env file
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const allowedOrigins = new Set([
  ...clientUrls,
  'https://chat-app-frontend-ochre-gamma.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const normalized = origin.replace(/\/$/, '');
    if (allowedOrigins.has(normalized) || allowedOrigins.has(origin) || normalized.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    console.warn(`[CORS] Blocked origin: ${origin}`);
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Status & Dev Auth helper route
app.get('/api/message', (req, res) => {
  res.json({ message: "Hello from the Node.js backend with Socket.io & S3 Presigned Uploads!" });
});

// Start Google OAuth login flow
app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Google OAuth is not configured on the server.' });
  }

  const redirectUri = getGoogleRedirectUri(req);
  const requestedRedirect = req.query.redirect;
  const allowedFrontendOrigin = (() => {
    if (typeof requestedRedirect === 'string') {
      try {
        const parsed = new URL(requestedRedirect);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.origin;
        }
      } catch (err) {
        console.warn('Invalid redirect origin supplied to Google OAuth:', requestedRedirect);
      }
    }

    return clientUrls[0] || 'https://chat-app-frontend-ochre-gamma.vercel.app';
  })();

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', allowedFrontendOrigin);
  res.redirect(authUrl.toString());
});

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
};

const verifyPassword = (password, storedHash) => {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) {
    return false;
  }

  const [salt, originalHash] = storedHash.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(originalHash, 'hex'), Buffer.from(derived, 'hex'));
};

const buildUserPayload = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  avatarUrl: user.avatarUrl,
  provider: user.provider,
});

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, avatarUrl, provider = 'local' } = req.body || {};

  if (!name?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        passwordHash: hashPassword(password),
        avatarUrl: avatarUrl || 'https://images.unsplash.com/photo-1544723795-3fb6469f5b39?w=150&auto=format&fit=crop&q=80',
        provider,
      },
    });

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: buildUserPayload(user) });
  } catch (error) {
    console.error('Signup failed:', error);
    res.status(500).json({ error: 'Failed to create account. Check your Prisma/MySQL configuration.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email?.trim() || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: buildUserPayload(user) });
  } catch (error) {
    console.error('Login failed:', error);
    res.status(500).json({ error: 'Failed to authenticate. Check your Prisma/MySQL configuration.' });
  }
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : req.cookies?.token;

  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.get('/api/me/rooms', authenticateToken, async (req, res) => {
  try {
    const payload = req.user;
    const memberships = await prisma.membership.findMany({
      where: { userId: payload.id },
      include: {
        room: {
          include: {
            memberships: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    });

    const rooms = await Promise.all(
      memberships.map(async (m) => {
        const room = m.room;
        const members = room.memberships.map((mem) => ({
          id: mem.user.id,
          name: mem.user.name,
          email: mem.user.email,
          avatarUrl: mem.user.avatarUrl,
          isOnline: isOnline(mem.user.id),
          lastSeenAt: mem.user.lastSeenAt,
        }));

        let unread = 0;
        let lastMessage = null;

        try {
          const [unreadCount, latestMsg] = await Promise.all([
            prisma.message.count({
              where: {
                roomId: room.id,
                senderId: { not: payload.id },
                readReceipts: {
                  none: {
                    userId: payload.id,
                  },
                },
              },
            }),
            prisma.message.findFirst({
              where: { roomId: room.id },
              orderBy: { createdAt: 'desc' },
              include: { sender: true },
            }),
          ]);

          unread = unreadCount;
          if (latestMsg) {
            lastMessage = {
              content: latestMsg.content,
              attachmentUrl: latestMsg.attachmentUrl,
              senderName: latestMsg.sender?.name || 'Netrunner',
              createdAt: latestMsg.createdAt,
            };
          }
          
        } catch (dbErr) {
          console.warn('Error fetching unread or last message:', dbErr.message);
        }

        return {
          id: room.id,
          name: room.name,
          type: room.type,
          createdAt: room.createdAt,
          unread,
          lastMessage,
          members,
        };
      })
    );

    res.json({ rooms });
  } catch (error) {
    console.error('Fetch rooms failed:', error);
    res.status(500).json({ error: 'Failed to load rooms' });
  }
});

app.post('/api/rooms', authenticateToken, async (req, res) => {
  try {
    const payload = req.user;
    const { name, type = 'channel', userIds = [] } = req.body || {};

    if (!name?.trim()) return res.status(400).json({ error: 'Room name is required.' });

    const uniqueUserIds = Array.from(new Set([payload.id, ...userIds]));

    const room = await prisma.room.create({
      data: {
        name: name.trim(),
        type,
        memberships: {
          create: uniqueUserIds.map((uId) => ({ userId: uId })),
        },
      },
    });

    const roomWithMemberships = await prisma.room.findUnique({
      where: { id: room.id },
      include: {
        memberships: {
          include: {
            user: true,
          },
        },
      },
    });

    const members = roomWithMemberships.memberships.map((mem) => ({
      id: mem.user.id,
      name: mem.user.name,
      email: mem.user.email,
      avatarUrl: mem.user.avatarUrl,
    }));

    const responseRoom = {
      id: room.id,
      name: room.name,
      type: room.type,
      createdAt: room.createdAt,
      members,
    };

    // Broadcast room:new socket event to all members
    for (const member of members) {
      const socketIds = getUserSockets(member.id);
      for (const socketId of socketIds) {
        io.to(socketId).emit('room:new', responseRoom);
      }
    }

    res.json({ room: responseRoom });
  } catch (error) {
    console.error('Room creation failed:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const payload = req.user;
    const users = await prisma.user.findMany({
      where: {
        id: { not: payload.id },
      },
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        isOnline: true,
        lastSeenAt: true,
      },
    });

    // Override DB isOnline with the authoritative in-memory presence map
    // to avoid serving stale flags left over from server restarts or crashes
    const liveOnlineIds = new Set(getOnlineUserIds());
    const usersWithLivePresence = users.map((u) => ({
      ...u,
      isOnline: liveOnlineIds.has(u.id),
    }));

    res.json({ users: usersWithLivePresence });
  } catch (error) {
    console.error('Fetch users failed:', error);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// Update signed-in user's own profile
app.patch('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const payload = req.user;
    const { name, avatarUrl } = req.body || {};

    const updateData = {};
    if (name !== undefined) updateData.name = name?.trim();
    if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;

    const updatedUser = await prisma.user.update({
      where: { id: payload.id },
      data: updateData,
    });

    res.json({ user: buildUserPayload(updatedUser) });
  } catch (error) {
    console.error('Update profile failed:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.get('/api/rooms/:roomId/messages', authenticateToken, async (req, res) => {
  try {
    const payload = req.user;
    const roomId = req.params.roomId;

    const membership = await prisma.membership.findFirst({
      where: { userId: payload.id, roomId },
    });

    if (!membership) return res.status(403).json({ error: 'Not a member of this room' });

    const messages = await prisma.message.findMany({
      where: { roomId },
      orderBy: { createdAt: 'asc' },
      include: { sender: true, readReceipts: true },
    });

    res.json({ messages });
  } catch (error) {
    console.error('Message fetch failed:', error);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

app.post('/api/rooms/:roomId/read', authenticateToken, async (req, res) => {
  try {
    const payload = req.user;
    const roomId = req.params.roomId;

    const unreadMessages = await prisma.message.findMany({
      where: {
        roomId,
        senderId: { not: payload.id },
        readReceipts: {
          none: {
            userId: payload.id,
          },
        },
      },
      select: { id: true },
    });

    if (unreadMessages.length > 0) {
      await Promise.all(
        unreadMessages.map((m) =>
          prisma.readReceipt.upsert({
            where: {
              messageId_userId: { messageId: m.id, userId: payload.id },
            },
            update: { readAt: new Date() },
            create: { messageId: m.id, userId: payload.id, readAt: new Date() },
          }).catch(() => null)
        )
      );

      // Broadcast message:read socket event to room members so double ticks turn green in real-time
      io.to(`room:${roomId}`).emit('message:read', {
        roomId,
        userId: payload.id,
        messageIds: unreadMessages.map((m) => m.id),
      });
      io.to(roomId).emit('message:read', {
        roomId,
        userId: payload.id,
        messageIds: unreadMessages.map((m) => m.id),
      });
    }

    res.json({ success: true, readCount: unreadMessages.length });
  } catch (error) {
    console.error('Mark read failed:', error);
    res.status(500).json({ error: 'Failed to mark room as read' });
  }
});

app.post('/api/rooms/:roomId/messages', authenticateToken, async (req, res) => {
  try {
    const payload = req.user;
    const roomId = req.params.roomId;
    const { content, attachmentUrl, replyTo, forwardedFrom, isForwarded } = req.body || {};

    if (!content?.trim() && !attachmentUrl) return res.status(400).json({ error: 'Message content is required.' });

    const membership = await prisma.membership.findFirst({
      where: { userId: payload.id, roomId },
    });

    if (!membership) return res.status(403).json({ error: 'Not a member of this room' });

    const serializedReplyTo = replyTo
      ? typeof replyTo === 'object'
        ? JSON.stringify(replyTo)
        : String(replyTo)
      : null;

    const serializedForwardedFrom = forwardedFrom
      ? typeof forwardedFrom === 'object'
        ? JSON.stringify(forwardedFrom)
        : String(forwardedFrom)
      : null;

    const message = await prisma.message.create({
      data: {
        roomId,
        senderId: payload.id,
        content: content?.trim() || '',
        attachmentUrl: attachmentUrl || null,
        replyTo: serializedReplyTo,
        forwardedFrom: serializedForwardedFrom,
        isForwarded: Boolean(isForwarded || forwardedFrom),
      },
      include: { sender: true, readReceipts: true },
    });

    res.json({ message });
  } catch (error) {
    console.error('Message creation failed:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.delete('/api/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const payload = req.user;
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { room: { include: { memberships: true } } },
    });

    if (!message) return res.status(404).json({ error: 'Message not found' });

    // Only the original sender may soft-delete their own message
    if (message.senderId !== payload.id) {
      return res.status(403).json({ error: 'Only the sender can delete their own message' });
    }

    // Soft-delete: mark isDeleted, wipe content & attachment so no data leaks
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        content: '',
        attachmentUrl: null,
      },
    });

    // Broadcast to the room so other members see the change in real-time
    io.to(`room:${message.roomId}`).emit('message:deleted', {
      messageId: updated.id,
      roomId: updated.roomId,
    });
    io.to(message.roomId).emit('message:deleted', {
      messageId: updated.id,
      roomId: updated.roomId,
    });

    res.json({ success: true, messageId: updated.id });
  } catch (error) {
    console.error('Message delete failed:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

app.patch('/api/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const payload = req.user;
    const { messageId } = req.params;
    const { content } = req.body || {};

    if (!content?.trim()) return res.status(400).json({ error: 'Message content is required.' });

    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message) return res.status(404).json({ error: 'Message not found' });

    if (message.senderId !== payload.id) {
      return res.status(403).json({ error: 'Only the sender can edit this message' });
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        content: content.trim(),
        isEdited: true,
      },
    });

    io.to(`room:${updated.roomId}`).emit('message:edited', {
      messageId: updated.id,
      roomId: updated.roomId,
      content: updated.content,
      isEdited: true,
    });
    io.to(updated.roomId).emit('message:edited', {
      messageId: updated.id,
      roomId: updated.roomId,
      content: updated.content,
      isEdited: true,
    });

    res.json({ message: updated });
  } catch (error) {
    console.error('Message edit failed:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

app.patch('/api/messages/:messageId/pin', authenticateToken, async (req, res) => {
  try {
    const payload = req.user;
    const { messageId } = req.params;
    const { isPinned } = req.body || {};

    const nextPinned = typeof isPinned === 'boolean' ? isPinned : true;

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { sender: true },
    });

    if (!message) return res.status(404).json({ error: 'Message not found' });

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { isPinned: nextPinned },
    });

    const user = await prisma.user.findUnique({ where: { id: payload.id } }).catch(() => null);
    const pinnerName = user?.name || user?.email || 'Someone';
    const snippet = message.content
      ? (message.content.length > 25 ? message.content.slice(0, 25) + '...' : message.content)
      : (message.attachmentUrl ? '📷 Attachment' : '');

    let systemMsg = null;
    if (updated.roomId && !updated.roomId.startsWith('room_')) {
      try {
        const meta = {
          type: 'system',
          isSystem: true,
          pinnedMessageId: messageId,
          pinnerId: payload.id,
          pinnerName,
          isPinned: nextPinned,
          snippet,
        };
        systemMsg = await prisma.message.create({
          data: {
            roomId: updated.roomId,
            senderId: payload.id,
            content: JSON.stringify(meta),
            replyTo: JSON.stringify(meta),
          },
          include: { sender: true },
        });
      } catch (err) {
        console.warn('Failed to persist system pin message in REST:', err.message);
      }
    }

    io.to(`room:${updated.roomId}`).emit('message:pinned', {
      messageId: updated.id,
      roomId: updated.roomId,
      isPinned: nextPinned,
      pinnerId: payload.id,
      pinnerName,
      snippet,
      systemMessageId: systemMsg?.id || `sys_pin_${updated.id}_${nextPinned ? 'pin' : 'unpin'}`,
    });

    res.json({ message: updated, systemMessage: systemMsg });
  } catch (error) {
    console.error('Message pin failed:', error);
    res.status(500).json({ error: 'Failed to update pin status' });
  }
});



app.get('/api/debug/data', async (req, res) => {
  try {
    const [users, rooms, memberships, messages] = await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          provider: true,
          createdAt: true,
        },
      }),
      prisma.room.findMany({
        select: {
          id: true,
          name: true,
          type: true,
          createdAt: true,
        },
      }),
      prisma.membership.findMany({
        select: {
          id: true,
          userId: true,
          roomId: true,
        },
      }),
      prisma.message.findMany({
        select: {
          id: true,
          roomId: true,
          senderId: true,
          content: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    res.json({ users, rooms, memberships, messages });
  } catch (error) {
    console.error('Debug data fetch failed:', error);
    res.status(500).json({ error: 'Failed to load debug data' });
  }
});

app.post('/api/debug/cleanup-duplicates', async (req, res) => {
  try {
    const allMessages = await prisma.message.findMany({
      orderBy: { createdAt: 'asc' },
    });

    const duplicateIdsToDelete = [];
    for (let i = 0; i < allMessages.length - 1; i++) {
      const current = allMessages[i];
      const next = allMessages[i + 1];

      if (
        current.roomId === next.roomId &&
        current.senderId === next.senderId &&
        current.content === next.content &&
        Math.abs(new Date(next.createdAt) - new Date(current.createdAt)) < 5000
      ) {
        duplicateIdsToDelete.push(next.id);
        i++;
      }
    }

    if (duplicateIdsToDelete.length > 0) {
      await prisma.message.deleteMany({
        where: { id: { in: duplicateIdsToDelete } },
      });
    }

    res.json({ success: true, deletedCount: duplicateIdsToDelete.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dev route to generate test JWT token for local testing
app.post('/api/auth/token', async (req, res) => {
  const { id = 'user_123', email = 'test@example.com', name = 'Test User', avatarUrl } = req.body || {};
  try {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await prisma.user.upsert({
      where: { email: normalizedEmail },
      update: { name: name.trim() },
      create: {
        id,
        email: normalizedEmail,
        name: name.trim(),
        avatarUrl: avatarUrl || 'https://images.unsplash.com/photo-1544723795-3fb6469f5b39?w=150&auto=format&fit=crop&q=80',
        provider: 'local',
      },
    });

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: buildUserPayload(user) });
  } catch (error) {
    console.error('Token generation notice:', error.message);
    const fallbackUser = { id, email, name, avatarUrl };
    const token = jwt.sign({ id, email, name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: fallbackUser });
  }
});

/**
 * 🔒 GOOGLE OAUTH CALLBACK ROUTE
 * This handles the authorization code redirect, gets user data, and logs them into your app.
 */
app.get('/api/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  const requestedState = req.query.state;
  const primaryClientUrl = (() => {
    if (typeof requestedState === 'string') {
      try {
        const decodedState = requestedState;
        const parsed = new URL(decodedState);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.origin;
        }
      } catch (err) {
        console.warn('Invalid state value received from Google OAuth:', requestedState);
      }
    }

    return clientUrls[0] || 'https://chat-app-frontend-ochre-gamma.vercel.app';
  })();

  if (!code) {
    return res.redirect(`${primaryClientUrl}/login?error=no_code_provided`);
  }

  try {
    // 1. Determine active server redirect URI dynamically matching the running host and port
    const redirectUri = getGoogleRedirectUri(req);

    // 2. Exchange authorization code for tokens
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    console.log('Google OAuth: Token response received:', tokenResponse.data);

    const { access_token } = tokenResponse.data;

    // 3. Retrieve user profile info from Google API
    const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const googleUser = userResponse.data; // Includes id, email, name, picture
    console.log('Google OAuth: Retrieved user info:', googleUser);

    // Upsert Google user into database so room memberships and presence tracking work seamlessly
    let dbUser;
    try {
      const normalizedEmail = (googleUser.email || `google_${googleUser.id}@example.com`).trim().toLowerCase();
      dbUser = await prisma.user.upsert({
        where: { email: normalizedEmail },
        update: {
          name: googleUser.name || 'Google User',
          avatarUrl: googleUser.picture || null,
          provider: 'google',
        },
        create: {
          id: googleUser.id || `google_${Date.now()}`,
          email: normalizedEmail,
          name: googleUser.name || 'Google User',
          avatarUrl: googleUser.picture || null,
          provider: 'google',
        },
      });
    } catch (dbErr) {
      console.warn('Google OAuth DB user upsert notice:', dbErr.message);
      dbUser = {
        id: googleUser.id || `google_${Date.now()}`,
        email: googleUser.email,
        name: googleUser.name,
        avatarUrl: googleUser.picture,
        provider: 'google',
      };
    }

    // 4. Generate your internal app JWT token
    const token = jwt.sign(
      {
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        picture: dbUser.avatarUrl,
        avatarUrl: dbUser.avatarUrl,
        provider: 'google',
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 5. Send token to frontend by redirecting with URL parameters
    res.redirect(`${primaryClientUrl}/auth-success?token=${encodeURIComponent(token)}`);

  } catch (error) {
    console.error('Google OAuth Error:', error.response?.data || error.message);
    res.redirect(`${primaryClientUrl}/login?error=authentication_failed`);
  }
});

// Upload Presigned URL Routes
app.use('/api/upload', uploadRoutes);

// Local upload endpoint for development without AWS credentials
app.put('/api/upload/mock-upload', (req, res) => {
  // key is of the form "uploads/<userId>/<uuid>.<ext>"
  // Strip the leading "uploads/" prefix because the static server already maps
  // the ./uploads directory to the /uploads route — avoiding double-prefix.
  const rawKey = req.query.key || 'upload.bin';
  const relKey = rawKey.startsWith('uploads/') ? rawKey.slice('uploads/'.length) : rawKey;
  const uploadDir = path.join(__dirname, 'uploads');
  const filePath = path.join(uploadDir, relKey);
  const fileDir = path.dirname(filePath);

  if (!fs.existsSync(fileDir)) {
    fs.mkdirSync(fileDir, { recursive: true });
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(filePath, buffer);
    res.status(200).json({ success: true, message: 'Local upload successful' });
  });
  req.on('error', (err) => {
    console.error('Mock upload stream error:', err);
    res.status(500).json({ error: 'Upload stream failed' });
  });
});

// Wrap Express with HTTP Server for Socket.io
const httpServer = http.createServer(app);
const io = initSocket(httpServer);
let PORT = Number(process.env.PORT || 5000);

const startServer = async () => {
  // Reset all stale isOnline flags from previous sessions on startup
  try {
    await prisma.user.updateMany({ data: { isOnline: false } });
    console.log('Presence state reset: all users marked offline on startup.');
  } catch (err) {
    console.warn('Could not reset presence state on startup:', err.message);
  }

  httpServer.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Socket.io & S3 Upload API ready.`);
    console.log(`Google Redirect URI configured to: http://localhost:${PORT}/api/auth/google/callback`);
  });
};

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const fallbackPort = PORT + 1;
    console.warn(`Port ${PORT} is busy. Retrying on ${fallbackPort}...`);
    PORT = fallbackPort;
    startServer();
  } else {
    console.error('Server startup error:', err);
    process.exit(1);
  }
});

startServer();

module.exports = { app, io, httpServer };
