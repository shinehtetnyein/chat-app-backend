const prisma = require('../prisma/client');

// userId -> Set<socketId>
const onlineUsers = new Map();

async function addConnection(io, userId, socketId) {
  const isFirstConnection = !onlineUsers.has(userId);
  if (isFirstConnection) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socketId);

  if (isFirstConnection) {
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { isOnline: true },
      });
    } catch (err) {
      console.log('Presence update notice:', err.message);
    }
    io.emit('presence:update', { userId, isOnline: true });
  }
}

async function removeConnection(io, userId, socketId) {
  const sockets = onlineUsers.get(userId);
  if (!sockets) return;

  sockets.delete(socketId);

  if (sockets.size === 0) {
    onlineUsers.delete(userId);
    const lastSeenAt = new Date();
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { isOnline: false, lastSeenAt },
      });
    } catch (err) {
      console.log('Presence update notice:', err.message);
    }
    io.emit('presence:update', { userId, isOnline: false, lastSeenAt });
  }
}

function isOnline(userId) {
  return onlineUsers.has(userId);
}

function getOnlineUserIds() {
  return Array.from(onlineUsers.keys());
}

function getUserSockets(userId) {
  return onlineUsers.get(userId) ? Array.from(onlineUsers.get(userId)) : [];
}

module.exports = { addConnection, removeConnection, isOnline, getOnlineUserIds, getUserSockets };
