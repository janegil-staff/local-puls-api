// localpulse/server/src/lib/dob.js
//
// Date-of-birth parsing, validation, and the 18+ gate.
//
// Age is computed with CALENDAR arithmetic, not by dividing elapsed
// milliseconds by 365.25 days. The division approach drifts by a day or two
// depending on where leap years fall, which for an age gate means someone
// can read as 18 shortly before their eighteenth birthday. On an app that
// puts strangers in proximity to each other, that is not an acceptable
// rounding error.

export const MIN_AGE = 18;
export const MAX_AGE = 120;

/**
 * Whole years between dob and `now`, by calendar.
 * Returns null for a missing or unparseable date.
 */
export function exactAge(dob, now = new Date()) {
  if (!dob) return null;

  const birth = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;

  let age = now.getUTCFullYear() - birth.getUTCFullYear();

  const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
  const dayDiff = now.getUTCDate() - birth.getUTCDate();

  // Birthday has not happened yet this year.
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1;

  return age;
}

/**
 * Parses and validates a date of birth from a request body.
 *
 * Accepts an ISO date string ("1990-04-17") or a Date. Time-of-day is
 * discarded — a birth date is a calendar date, and keeping a timestamp
 * makes the same DOB compute differently either side of midnight in
 * whatever timezone the server happens to run in.
 *
 * Returns { ok: true, dob, age } or { ok: false, error }.
 * `error` is a translation key, not a sentence — the app renders it.
 */
export function parseDob(input, now = new Date()) {
  if (input === undefined || input === null || input === "") {
    return { ok: false, error: "dobRequired" };
  }

  const parsed = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "dobInvalid" };
  }

  // Normalise to midnight UTC on the calendar date given.
  const dob = new Date(
    Date.UTC(
      parsed.getUTCFullYear(),
      parsed.getUTCMonth(),
      parsed.getUTCDate(),
    ),
  );

  if (dob.getTime() > now.getTime()) {
    return { ok: false, error: "dobInFuture" };
  }

  const age = exactAge(dob, now);

  if (age < MIN_AGE) {
    return { ok: false, error: "dobUnderAge" };
  }

  if (age > MAX_AGE) {
    return { ok: false, error: "dobInvalid" };
  }

  return { ok: true, dob, age };
}

/**
 * Whether a user may change an already-set date of birth.
 *
 * DOB is not an ordinary profile field. Letting it be edited freely means an
 * account can pass the age gate at signup and then change afterwards, and it
 * lets someone re-target which age bracket they appear in as often as they
 * like. Both matter more here than on most apps, because this one puts
 * strangers in physical proximity.
 *
 * The rule: it can be corrected, because people do mistype their birthday
 * during signup, but not repeatedly. Past the limit it needs support.
 */
export const DOB_CHANGE_LIMIT = 2;

export function canChangeDob(user) {
  if (!user?.dob) return { allowed: true }; // never set — onboarding
  if ((user.dobChangeCount || 0) < DOB_CHANGE_LIMIT) return { allowed: true };
  return { allowed: false, error: "dobChangeLimit" };
}
