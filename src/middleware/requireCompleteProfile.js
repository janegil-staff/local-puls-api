// localpulse/api/src/middleware/requireCompleteProfile.js

import { User } from "../models/User.js";
import { errorHandler } from "./error.js";

export async function requireCompleteProfile(req, res, next) {
  var user = await User.findById(req.auth.userId);
  if (!user) return next(new errorHandler(401, "Authentication required."));

  var missing = user.missingProfileFields();
  if (missing.length) {
    // 428: the request is fine, but a precondition has not been met.
    // Distinct from 403 so the app can route to onboarding rather than
    // showing a permission error.
    return next(
      new ApiError(428, "Profile is incomplete.", {
        missingProfileFields: missing,
      }),
    );
  }
  next();
}
