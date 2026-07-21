// localpulse/api/src/controllers/feedController.js
console.log('[feed] userId=', req.user?.id, 'coords=', req.user?.location?.coordinates);
console.log('[feed] filter=', JSON.stringify(filter));
const posts = await Post.find(filter).limit(30);
console.log('[feed] matched=', posts.length);