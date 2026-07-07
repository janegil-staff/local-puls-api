// localpulse/server/src/controllers/userController.js
import User from '../models/User.js';
import Follow from '../models/Follow.js';
import Post from '../models/Post.js';
import { notify } from '../lib/notify.js';

// Public profile + follower/following counts + whether the viewer follows them.
export async function getProfile(req, res) {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [followers, following, viewerFollows, posts] = await Promise.all([
      Follow.countDocuments({ following: user._id }),
      Follow.countDocuments({ follower: user._id }),
      req.userId
        ? Follow.exists({ follower: req.userId, following: user._id })
        : Promise.resolve(false),
      Post.find({ author: user._id }).sort({ createdAt: -1 }).limit(20).populate('author'),
    ]);

    return res.json({
      profile: {
        ...user.toPublic(),
        followerCount: followers,
        followingCount: following,
        followedByMe: Boolean(viewerFollows),
      },
      posts: posts.map((p) => p.toClient(req.userId)),
    });
  } catch (err) {
    console.error('getProfile error', err);
    return res.status(500).json({ error: 'Could not load profile' });
  }
}

export async function follow(req, res) {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (String(target._id) === String(req.userId)) {
      return res.status(400).json({ error: "You can't follow yourself" });
    }
    await Follow.updateOne(
      { follower: req.userId, following: target._id },
      { $setOnInsert: { follower: req.userId, following: target._id } },
      { upsert: true }
    );
    await notify({
      userId: target._id,
      actorId: req.userId,
      type: 'follow',
      title: 'New follower',
      body: 'Someone started following you',
    });
    return res.json({ following: true });
  } catch (err) {
    console.error('follow error', err);
    return res.status(500).json({ error: 'Could not follow' });
  }
}

export async function unfollow(req, res) {
  try {
    await Follow.deleteOne({ follower: req.userId, following: req.params.id });
    return res.json({ following: false });
  } catch (err) {
    console.error('unfollow error', err);
    return res.status(500).json({ error: 'Could not unfollow' });
  }
}

// Feed of posts from people the viewer follows.
export async function followingFeed(req, res) {
  try {
    const { before, limit } = req.query;
    const lim = Math.min(Number(limit) || 20, 50);

    const edges = await Follow.find({ follower: req.userId }).select('following');
    const ids = edges.map((e) => e.following);

    const posts = await Post.find({
      author: { $in: ids },
      ...(before ? { createdAt: { $lt: new Date(before) } } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(lim)
      .populate('author');

    return res.json({ posts: posts.map((p) => p.toClient(req.userId)) });
  } catch (err) {
    console.error('followingFeed error', err);
    return res.status(500).json({ error: 'Could not load following feed' });
  }
}

// Update own profile (bio, displayName, avatarUrl).
export async function updateProfile(req, res) {
  try {
    const { displayName, bio, avatarUrl } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (displayName != null) user.displayName = displayName;
    if (bio != null) user.bio = bio;
    if (avatarUrl != null) user.avatarUrl = avatarUrl;
    await user.save();
    return res.json({ user: user.toPublic() });
  } catch (err) {
    console.error('updateProfile error', err);
    return res.status(500).json({ error: 'Could not update profile' });
  }
}
