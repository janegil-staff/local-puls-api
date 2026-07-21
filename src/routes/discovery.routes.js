// localpulse/server/src/routes/discovery.routes.js
import { Router } from 'express';
import { getDeck } from '../controllers/discoveryController.js';
import { swipe, listMatches, unmatch } from '../controllers/matchController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/discovery', requireAuth, getDeck);
router.post('/swipe/:userId', requireAuth, swipe);
router.get('/matches', requireAuth, listMatches);
router.delete('/matches/:id', requireAuth, unmatch);

export default router;
