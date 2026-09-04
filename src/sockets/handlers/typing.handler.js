module.exports = function registerTypingHandlers(io, socket) {
  socket.on('typing:start', ({ roomId }) => {
    socket.to(`room:${roomId}`).emit('typing:update', {
      roomId,
      userId: socket.user.id,
      isTyping: true,
    });
  });

  socket.on('typing:stop', ({ roomId }) => {
    socket.to(`room:${roomId}`).emit('typing:update', {
      roomId,
      userId: socket.user.id,
      isTyping: false,
    });
  });
};
