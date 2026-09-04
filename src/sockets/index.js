const { Server } = require('socket.io');
const { verifyToken } = require('../middlewares/auth.middleware');
const registerMessageHandlers = require('./handlers/message.handler');
const registerPresenceHandlers = require('./handlers/presence.handler');
const registerTypingHandlers = require('./handlers/typing.handler');
const registerReadReceiptHandlers = require('./handlers/readReceipt.handler');

function initSocket(httpServer) {
  const clientOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const normalized = origin.replace(/\/$/, '');
        if (clientOrigins.includes(normalized) || clientOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
          callback(null, true);
          return;
        }
        callback(new Error('Origin not allowed by CORS'));
      },
      credentials: true,
    },
  });

  // Runs once per connection attempt before "connection" fires
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.split(' ')[1];

    const payload = verifyToken(token);
    if (!payload) return next(new Error('Unauthorized'));

    socket.user = payload; // { id, email, name }
    next();
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: user=${socket.user.id} socket=${socket.id}`);

    registerPresenceHandlers(io, socket);
    registerMessageHandlers(io, socket);
    registerTypingHandlers(io, socket);
    registerReadReceiptHandlers(io, socket);

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: user=${socket.user.id} socket=${socket.id}`);
    });
  });

  return io;
}

module.exports = { initSocket };
