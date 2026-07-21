// localpulse/server/src/routes/auth.routes.js
import { Router } from 'express';
import {
  register, login, me,
  verifyEmail, resendVerification,
  requestPinReset, resetPin,
  changePin,
} from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.post(
  '/register',
  authLimiter,
  validate({ body: { email: { required: true, type: 'string', isEmail: true } } }),
  register
);
router.post(
  '/login',
  authLimiter,
  validate({ body: { emailOrUsername: { required: true }, password: { required: true } } }),
  login
);

router.get('/verify/:token', verifyEmail);
router.post('/resend-verification', requireAuth, resendVerification);

router.post('/forgot-pin', authLimiter, requestPinReset);
router.post('/reset-pin', authLimiter, resetPin);
router.post('/change-pin', requireAuth, authLimiter, changePin);

export default router;
