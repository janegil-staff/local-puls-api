// localpulse/api/src/config/db.js

import mongoose from "mongoose";

export async function connectDb() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || undefined,
  });
  console.log("MongoDB connected");
}
