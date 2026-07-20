async function seedUsers() {
  const passwordHash = await bcrypt.hash(
    SEED_PASSWORD,
    12,
  );

  const seededUsers = [];

  for (const profile of DEMO_PROFILES) {
    const userData = buildUserData(
      profile,
      passwordHash,
    );

    /*
     * Locate an existing demo profile by either unique identifier.
     * This handles seed accounts created previously with a different
     * email address.
     */
    const existingUser = await User.findOne({
      $or: [
        { username: profile.username },
        { email: profile.email },
      ],
    });

    /*
     * Protect genuine users from being overwritten.
     *
     * Remove this check only if these usernames are guaranteed to
     * belong exclusively to your demo data.
     */
    if (
      existingUser &&
      existingUser.isSeedUser !== true
    ) {
      throw new Error(
        `Cannot seed "${profile.username}": ` +
        `an existing non-seed user already uses ` +
        `"${existingUser.username}" / "${existingUser.email}".`,
      );
    }

    const filter = existingUser
      ? { _id: existingUser._id }
      : { username: profile.username };

    const user = await User.findOneAndUpdate(
      filter,
      {
        $set: userData,
        $unset: {
          pinHash: '',
          pinResetHash: '',
          pinResetExpires: '',
        },
      },
      {
        returnDocument: 'after',
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    seededUsers.push(user);

    console.log(
      `Seeded user: ${user.username}`,
    );
  }

  return seededUsers;
}