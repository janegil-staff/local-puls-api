import "dotenv/config";
import mongoose from "mongoose";
import { config } from "../config/index.js";

const EMAIL = process.argv[2];
if (!EMAIL) {
  console.error("usage: node /tmp/badge.mjs someone@example.test");
  process.exit(1);
}

await mongoose.connect(config.mongoUri);
const db = mongoose.connection.db;

const user = await db
  .collection("users")
  .findOne({ email: EMAIL.toLowerCase() });
if (!user) {
  console.log("No user with that email.");
  await mongoose.disconnect();
  process.exit(0);
}

const me = user._id;
console.log("user:", user.username, String(me), "\n");

const convos = await db
  .collection("conversations")
  .find({ participants: me })
  .toArray();
console.log("conversations:", convos.length);

let accepted = 0;
for (const c of convos) {
  const unread = await db.collection("messages").countDocuments({
    conversation: c._id,
    sender: { $ne: me },
    readBy: { $ne: me },
  });
  const iAmRecipient = String(c.initiator) !== String(me);
  if (c.status === "accepted") accepted += unread;
  console.log(
    ` ${String(c._id)}  ${c.status.padEnd(8)}  ${iAmRecipient ? "recipient" : "initiator"}  unread=${unread}`,
  );
}

const requestCount = await db.collection("conversations").countDocuments({
  participants: me,
  status: "pending",
  initiator: { $ne: me },
});

console.log("\nendpoint would return:");
console.log("  count        =", accepted, "(unread in ACCEPTED only)");
console.log("  requestCount =", requestCount);
console.log("  badge shows  =", accepted + requestCount);

await mongoose.disconnect();
