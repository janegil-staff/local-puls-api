// scripts/removeDemoData.js
//
// Removes demo users and everything attached to them: posts, comments,
// conversations and messages.
//
// RUN removeSeedAssets.js FIRST. Once these documents are gone the Cloudinary
// public IDs go with them, and those assets become orphans no script can find.

import 'dotenv/config';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Post from '../src/models/Post.js';
import Comment from '../src/models/Comment.js';
import Conversation from '../src/models/Conversation.js';
import Message from '../src/models/Message.js';

const MONGODB_URI = process.env.MONGO_URI;

// The demo users all use @example.test emails (see seedDemoData.js). Targeting
// by this domain is reliable because `email` is a real schema field, unlike
// isSeedUser which may not be defined in User.js (and would then be dropped by
// Mongoose on save — the usual reason a { isSeedUser: true } query returns []).
const DEMO_EMAIL_DOMAIN = '@example.test';

// Escape every regex metacharacter, not just the first dot.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Schema field names differ between projects. Resolve them at runtime so this
// script does not silently match nothing because the field is called
// `members` rather than `participants`.
function resolveField(model, candidates) {
  const found = candidates.find((name) => model.schema.path(name));
  if (!found) {
    throw new Error(
      `${model.modelName}: none of these fields exist — ${candidates.join(', ')}. ` +
        'Check the schema and update the candidate list.'
    );
  }
  return found;
}

// Same, but returns null instead of throwing — for genuinely optional fields
// such as comment threading, which not every schema has.
function optionalField(model, candidates) {
  return candidates.find((name) => model.schema.path(name)) ?? null;
}

async function removeDemoData() {
  if (!MONGODB_URI) {
    throw new Error('MONGO_URI is missing from the environment.');
  }

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  // Match demo users by email domain OR the isSeedUser flag, so this works
  // whether or not isSeedUser persisted. The regex is anchored to the end of
  // the string so it can't match a real user who merely contains the text.
  const query = {
    $or: [
      { email: { $regex: `${escapeRegex(DEMO_EMAIL_DOMAIN)}$`, $options: 'i' } },
      { isSeedUser: true },
    ],
  };

  const demoUsers = await User.find(query, { _id: 1, username: 1, email: 1 }).lean();

  if (demoUsers.length === 0) {
    console.log('No demo users found.');
    return;
  }

  const userIds = demoUsers.map((user) => user._id);
  console.log(`Found ${demoUsers.length} demo users:`);
  demoUsers.forEach((user) => console.log(`  ${user.username} <${user.email}>`));

  const participantsField = resolveField(Conversation, [
    'participants',
    'members',
    'users',
  ]);
  const conversationField = resolveField(Message, [
    'conversation',
    'conversationId',
    'chat',
  ]);
  const commentAuthorField = resolveField(Comment, ['author', 'user', 'createdBy']);
  const commentPostField = resolveField(Comment, ['post', 'postId']);
  // Threaded replies are optional — many schemas are flat.
  const commentParentField = optionalField(Comment, [
    'parent',
    'parentComment',
    'parentId',
    'replyTo',
  ]);

  // ----- conversations and messages -----

  // Every conversation a demo user took part in, including one-to-one chats
  // with real users. Those conversations are demo data too — the other side
  // was talking to an account that does not represent a person.
  const conversations = await Conversation.find(
    { [participantsField]: { $in: userIds } },
    { _id: 1 }
  ).lean();

  const conversationIds = conversations.map((conversation) => conversation._id);

  // Delete messages by CONVERSATION, not by sender. Deleting only the demo
  // users' own messages would leave real users' replies orphaned, pointing at
  // a conversation that no longer exists.
  const messageResult = conversationIds.length
    ? await Message.deleteMany({ [conversationField]: { $in: conversationIds } })
    : { deletedCount: 0 };

  const conversationResult = conversationIds.length
    ? await Conversation.deleteMany({ _id: { $in: conversationIds } })
    : { deletedCount: 0 };

  // Any stragglers: messages sent by a demo user in a conversation that was
  // somehow not matched above. Cheap to run, and leaves nothing behind.
  const orphanMessageResult = await Message.deleteMany({
    $or: [{ sender: { $in: userIds } }, { author: { $in: userIds } }].filter((clause) =>
      Message.schema.path(Object.keys(clause)[0])
    ),
  });

  // ----- posts and comments -----

  // Collect post IDs BEFORE deleting the posts, so comments on them can still
  // be found.
  const demoPosts = await Post.find({ author: { $in: userIds } }, { _id: 1 }).lean();
  const postIds = demoPosts.map((post) => post._id);

  // Two directions, both necessary:
  //   1. Comments written BY a demo user — including on real users' posts.
  //   2. Comments written by anyone ON a demo user's post — that post is being
  //      deleted, so leaving these behind strands them.
  const commentResult = await Comment.deleteMany({
    $or: [
      { [commentAuthorField]: { $in: userIds } },
      ...(postIds.length ? [{ [commentPostField]: { $in: postIds } }] : []),
    ],
  });

  // Threaded replies: a real user's reply to a demo user's comment on a real
  // post survives the pass above, because neither its author nor its post is
  // demo data. Sweep until no comment points at a missing parent.
  //
  // Bounded so a cycle in the data cannot spin forever — a thread deeper than
  // 20 levels is a data problem worth seeing rather than silently grinding on.
  let orphanCommentCount = 0;
  if (commentParentField) {
    for (let pass = 0; pass < 20; pass += 1) {
      const withParent = await Comment.find(
        { [commentParentField]: { $ne: null } },
        { _id: 1, [commentParentField]: 1 }
      ).lean();

      if (withParent.length === 0) break;

      const parentIds = [
        ...new Set(withParent.map((c) => String(c[commentParentField]))),
      ];
      const existing = await Comment.find(
        { _id: { $in: parentIds } },
        { _id: 1 }
      ).lean();
      const existingIds = new Set(existing.map((c) => String(c._id)));

      const orphanIds = withParent
        .filter((c) => !existingIds.has(String(c[commentParentField])))
        .map((c) => c._id);

      if (orphanIds.length === 0) break;

      const result = await Comment.deleteMany({ _id: { $in: orphanIds } });
      orphanCommentCount += result.deletedCount;
    }
  }

  const postResult = postIds.length
    ? await Post.deleteMany({ _id: { $in: postIds } })
    : { deletedCount: 0 };

  // Users last, so a crash mid-run leaves them findable for a re-run rather
  // than orphaning everything above.
  const userResult = await User.deleteMany({ _id: { $in: userIds } });

  console.log('');
  console.log('Demo data removed.');
  console.log(`Conversations deleted : ${conversationResult.deletedCount}`);
  console.log(`Messages deleted      : ${messageResult.deletedCount}`);
  console.log(`Orphan messages       : ${orphanMessageResult.deletedCount}`);
  console.log(`Comments deleted      : ${commentResult.deletedCount}`);
  console.log(`Orphan replies        : ${orphanCommentCount}`);
  console.log(`Posts deleted         : ${postResult.deletedCount}`);
  console.log(`Users deleted         : ${userResult.deletedCount}`);
}

removeDemoData()
  .catch((error) => {
    console.error('Remove demo data failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });