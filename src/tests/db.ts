import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer | null = null;

// Mongoose remembers when it has "built" indexes for a model within a
// process. With mongodb-memory-server every test suite connects to a fresh
// in-memory database, so unique indexes (e.g. users.email) silently go
// missing in the new DB — duplicate-key tests then pass-through instead of
// surfacing 409s. Calling syncIndexes() on every registered model after
// connecting forces a rebuild against the new connection.
const ensureIndexes = async (): Promise<void> => {
  const models = mongoose.modelNames();
  await Promise.all(
    models.map(async (name) => {
      const model = mongoose.model(name);
      await model.syncIndexes();
    })
  );
};

export const startTestDb = async (): Promise<void> => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  await ensureIndexes();
};

export const stopTestDb = async (): Promise<void> => {
  await mongoose.disconnect();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
};

export const clearTestDb = async (): Promise<void> => {
  // Re-read collections every call: a test that touches a previously-unused
  // model registers a new collection mid-suite, and a cached list would
  // silently skip clearing it.
  const collections = mongoose.connection.collections;
  await Promise.all(
    Object.values(collections).map((c) => c.deleteMany({}))
  );
};
