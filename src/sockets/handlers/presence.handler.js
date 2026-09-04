const { addConnection, removeConnection } = require('../../services/presence.service');

module.exports = function registerPresenceHandlers(io, socket) {
  addConnection(io, socket.user.id, socket.id);

  socket.on('disconnect', () => {
    removeConnection(io, socket.user.id, socket.id);
  });
};
