let PrismaClient;
try {
  PrismaClient = require('@prisma/client').PrismaClient;
} catch (e) {
  PrismaClient = null;
}

let prisma;
if (PrismaClient) {
  try {
    prisma = global.__prisma || new PrismaClient();
    if (process.env.NODE_ENV !== 'production') global.__prisma = prisma;
  } catch (err) {
    console.warn('PrismaClient init notice:', err.message);
  }
}

// Fallback dummy proxy if prisma client isn't generated or connected yet
if (!prisma) {
  const dummyQuery = async () => null;
  prisma = {
    user: { findFirst: dummyQuery, findUnique: dummyQuery, update: dummyQuery, create: dummyQuery },
    room: { findFirst: dummyQuery, findUnique: dummyQuery, create: dummyQuery },
    membership: { findFirst: dummyQuery, create: dummyQuery },
    message: { findFirst: dummyQuery, create: dummyQuery, findMany: dummyQuery },
    readReceipt: { upsert: dummyQuery, findFirst: dummyQuery },
  };
}

module.exports = prisma;
