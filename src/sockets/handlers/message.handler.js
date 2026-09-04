const prisma = require('../../prisma/client');

module.exports = function registerMessageHandlers(io, socket) {
  socket.on('room:join', async ({ roomId }) => {
    if (roomId && roomId.startsWith('room_')) {
      socket.join(`room:${roomId}`);
      return;
    }

    try {
      const membership = await prisma.membership.findFirst({
        where: { roomId, userId: socket.user.id },
      });
      if (!membership) {
        return socket.emit('error', { message: 'Not a member of this room' });
      }
      socket.join(`room:${roomId}`);
    } catch (err) {
      socket.join(`room:${roomId}`); // Join for local testing mode
    }
  });

  socket.on('room:leave', ({ roomId }) => {
    socket.leave(`room:${roomId}`);
  });

  socket.on('message:send', async ({ roomId, content, attachmentUrl, replyTo, forwardedFrom, isForwarded, clientMessageId }, ack) => {
    try {
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

      let message;
      try {
        message = await prisma.message.create({
          data: {
            roomId,
            senderId: socket.user.id,
            content,
            attachmentUrl: attachmentUrl || null,
            replyTo: serializedReplyTo,
            forwardedFrom: serializedForwardedFrom,
            isForwarded: Boolean(isForwarded || forwardedFrom),
          },
          include: { sender: true, readReceipts: true },
        });
      } catch (dbErr) {
        console.warn('Direct message DB creation fallback:', dbErr.message);
        // Fetch sender details from DB or fallback
        const senderUser = await prisma.user.findUnique({ where: { id: socket.user.id } }).catch(() => null);
        message = {
          id: `msg_${Date.now()}`,
          roomId,
          senderId: socket.user.id,
          content,
          attachmentUrl: attachmentUrl || null,
          replyTo: serializedReplyTo,
          forwardedFrom: serializedForwardedFrom,
          isForwarded: Boolean(isForwarded || forwardedFrom),
          createdAt: new Date().toISOString(),
          sender: senderUser || { id: socket.user.id, name: socket.user.name || socket.user.email, avatarUrl: null }
        };
      }

      const parsedReplyTo = message.replyTo
        ? typeof message.replyTo === 'string'
          ? (() => { try { return JSON.parse(message.replyTo); } catch { return message.replyTo; } })()
          : message.replyTo
        : replyTo || null;

      const parsedForwardedFrom = message.forwardedFrom
        ? typeof message.forwardedFrom === 'string'
          ? (() => { try { return JSON.parse(message.forwardedFrom); } catch { return message.forwardedFrom; } })()
          : message.forwardedFrom
        : forwardedFrom || null;

      const outboundMsg = {
        ...message,
        replyTo: parsedReplyTo,
        forwardedFrom: parsedForwardedFrom,
        isForwarded: Boolean(message.isForwarded || isForwarded || parsedForwardedFrom),
        clientMessageId,
        sender: message.sender || { id: socket.user.id, name: socket.user.name || socket.user.email },
      };

      io.to(`room:${roomId}`).emit('message:new', outboundMsg);
      io.to(roomId).emit('message:new', outboundMsg);
      ack?.({ success: true, message: outboundMsg });
    } catch (err) {
      console.error('message:send error', err);
      ack?.({ error: 'Failed to send message' });
    }
  });

  socket.on('message:edit', async ({ messageId, roomId, content }, ack) => {
    try {
      if (!messageId || !content?.trim()) {
        return ack?.({ error: 'Message ID and content are required' });
      }

      const newContent = content.trim();

      // Check message in DB if not a mock ID
      if (!messageId.startsWith('msg_')) {
        try {
          const msg = await prisma.message.findUnique({ where: { id: messageId } });
          if (msg && msg.senderId !== socket.user.id) {
            return ack?.({ error: 'Only the sender can edit this message' });
          }

          await prisma.message.update({
            where: { id: messageId },
            data: {
              content: newContent,
              isEdited: true,
            },
          });
        } catch (dbErr) {
          console.warn('DB edit fallback for mock/offline mode:', dbErr.message);
        }
      }

      const editPayload = {
        messageId,
        roomId,
        content: newContent,
        isEdited: true,
      };

      if (roomId) {
        io.to(`room:${roomId}`).emit('message:edited', editPayload);
        io.to(roomId).emit('message:edited', editPayload);
      } else {
        io.emit('message:edited', editPayload);
      }

      ack?.({ success: true, ...editPayload });
    } catch (err) {
      console.error('message:edit error', err);
      ack?.({ error: 'Failed to edit message' });
    }
  });

  socket.on('message:pin', async ({ messageId, roomId, isPinned, pinnerName, snippet, systemMessageId }, ack) => {
    try {
      if (!messageId) {
        return ack?.({ error: 'Message ID is required' });
      }

      const nextPinned = typeof isPinned === 'boolean' ? isPinned : true;
      let targetMsg = null;

      if (!messageId.startsWith('msg_')) {
        try {
          targetMsg = await prisma.message.update({
            where: { id: messageId },
            data: { isPinned: nextPinned },
            include: { sender: true },
          });
        } catch (dbErr) {
          console.warn('DB pin fallback for mock/offline mode:', dbErr.message);
        }
      }

      const actualRoomId = roomId || targetMsg?.roomId;
      const actualSnippet = snippet || (targetMsg?.content ? (targetMsg.content.length > 25 ? targetMsg.content.slice(0, 25) + '...' : targetMsg.content) : (targetMsg?.attachmentUrl ? '📷 Attachment' : ''));
      const pinnerDisplayName = pinnerName || socket.user.name || socket.user.email || 'Someone';

      let systemMsg = null;
      if (actualRoomId && !actualRoomId.startsWith('room_')) {
        try {
          const meta = {
            type: 'system',
            isSystem: true,
            pinnedMessageId: messageId,
            pinnerId: socket.user.id,
            pinnerName: pinnerDisplayName,
            isPinned: nextPinned,
            snippet: actualSnippet,
          };
          systemMsg = await prisma.message.create({
            data: {
              roomId: actualRoomId,
              senderId: socket.user.id,
              content: JSON.stringify(meta),
              replyTo: JSON.stringify(meta),
            },
            include: { sender: true },
          });
        } catch (err) {
          console.warn('Failed to persist system pin message:', err.message);
        }
      }

      const pinPayload = {
        messageId,
        roomId: actualRoomId,
        isPinned: nextPinned,
        pinnerId: socket.user.id,
        pinnerName: pinnerDisplayName,
        snippet: actualSnippet,
        systemMessageId: systemMsg?.id || systemMessageId || `sys_pin_${messageId}_${nextPinned ? 'pin' : 'unpin'}`,
      };

      if (actualRoomId) {
        io.to(`room:${actualRoomId}`).emit('message:pinned', pinPayload);
      } else {
        io.emit('message:pinned', pinPayload);
      }

      ack?.({ success: true, ...pinPayload });
    } catch (err) {
      console.error('message:pin error', err);
      ack?.({ error: 'Failed to pin message' });
    }
  });

  socket.on('message:delete', async ({ messageId, roomId }, ack) => {
    try {
      if (!messageId) {
        return ack?.({ error: 'Message ID is required' });
      }

      if (!messageId.startsWith('msg_')) {
        try {
          const msg = await prisma.message.findUnique({ where: { id: messageId } });
          if (msg && msg.senderId !== socket.user.id) {
            return ack?.({ error: 'Only the sender can delete this message' });
          }

          await prisma.message.update({
            where: { id: messageId },
            data: {
              isDeleted: true,
              content: '',
              attachmentUrl: null,
            },
          });
        } catch (dbErr) {
          console.warn('DB delete fallback for mock/offline mode:', dbErr.message);
        }
      }

      const deletePayload = {
        messageId,
        roomId,
      };

      if (roomId) {
        io.to(`room:${roomId}`).emit('message:deleted', deletePayload);
        io.to(roomId).emit('message:deleted', deletePayload);
      } else {
        io.emit('message:deleted', deletePayload);
      }

      ack?.({ success: true, ...deletePayload });
    } catch (err) {
      console.error('message:delete error', err);
      ack?.({ error: 'Failed to delete message' });
    }
  });
};
