const prisma = require('../../prisma/client');

module.exports = function registerReadReceiptHandlers(io, socket) {
  socket.on('message:read', async ({ roomId, messageId }) => {
    const readAt = new Date();
    const userId = socket.user?.id || 'usr_netrunner_01';

    try {
      if (messageId) {
        await prisma.readReceipt.upsert({
          where: {
            messageId_userId: { messageId, userId },
          },
          update: { readAt },
          create: { messageId, userId, readAt },
        });
      } else if (roomId) {
        const unread = await prisma.message.findMany({
          where: {
            roomId,
            senderId: { not: userId },
            readReceipts: { none: { userId } },
          },
          select: { id: true },
        });

        await Promise.all(
          unread.map((m) =>
            prisma.readReceipt.upsert({
              where: { messageId_userId: { messageId: m.id, userId } },
              update: { readAt },
              create: { messageId: m.id, userId, readAt },
            }).catch(() => null)
          )
        );
      }
    } catch (err) {
      // Ignore DB errors during mock development
    }

    if (roomId) {
      io.to(`room:${roomId}`).emit('message:read', {
        roomId,
        messageId,
        userId,
        readAt,
      });
      io.to(roomId).emit('message:read', {
        roomId,
        messageId,
        userId,
        readAt,
      });
    }
  });
};
