import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer | null = null;

export const startTestDb = async (): Promise<void> => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
};

export const stopTestDb = async (): Promise<void> => {
  await mongoose.disconnect();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
};

export const clearTestDb = async (): Promise<void> => {
  const collections = mongoose.connection.collections;
  await Promise.all(
    Object.values(collections).map((c) => c.deleteMany({}))
  );
};
