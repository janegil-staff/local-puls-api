// localpulse/server/src/lib/defaultShowPreference.js
//
// Discovery defaults to the opposite sex rather than everyone.
//
// Only male and female have an "opposite". Non-binary, other, and unset all
// fall back to `everyone` — narrowing them to one side would silently
// exclude people from their own results based on a guess.

export const SHOW_VALUES = ['women', 'men', 'everyone'];

const OPPOSITE = {
  male: 'women',
  female: 'men',
};

export function defaultShowFor(gender) {
  return OPPOSITE[String(gender || '').toLowerCase()] || 'everyone';
}

// showSetByUser is what makes this safe to re-run: without it there is no way
// to tell "never touched, still on the default" from "deliberately set to
// everyone", and a later gender change would quietly overwrite a real choice.
//
// Returns true if anything changed.
export function applyDefaultShow(user) {
  if (!user) return false;
  if (user.preferences?.showSetByUser) return false;

  const next = defaultShowFor(user.gender);
  if (user.preferences?.show === next) return false;

  user.preferences = { ...(user.preferences || {}), show: next };
  return true;
}
