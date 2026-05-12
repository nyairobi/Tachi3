/**
 * Seed / upsert users into MongoDB (standalone; not wired to this repo's app).
 *
 * Usage:
 *   mongosh "mongodb://127.0.0.1:27017/YOUR_DB_NAME" --file scripts/mongo-insert-users.mongosh.js
 *
 * Override IDs (comma- or space-separated):
 *   USER_IDS="1001,1002" mongosh "mongodb://127.0.0.1:27017/YOUR_DB" --file scripts/mongo-insert-users.mongosh.js
 *
 * If USER_IDS is unset, defaults to 1, 2, 3 (edit DEFAULT_USER_IDS below).
 */

const DEFAULT_USER_IDS = [1, 2, 3];

const USER_IDS =
	typeof process !== "undefined" && process.env.USER_IDS
		? process.env.USER_IDS.split(/[\s,]+/)
				.map((s) => parseInt(s, 10))
				.filter((n) => !Number.isNaN(n))
		: DEFAULT_USER_IDS;

const PASSWORD_HASH =
	"$2b$12$XXXXXXXjo9lrnLGCree4e.tm7PSWwA5N.Lb8yLDzP8ytDt6cZAtuy";

for (const userId of USER_IDS) {
	const username = `mysteryman${userId}`;
	const email = `${username}@example.com`;

	db.getCollection("users").updateOne(
		{ id: userId },
		{
			$set: {
				id: userId,
				username,
				usernameLowercase: username,
				about: "I'm a fairly nondescript person.",
				socialMedia: {},
				status: null,
				customBannerLocation: null,
				customPfpLocation: null,
				joinDate: 1638903236112,
				lastSeen: 1772301833519,
				authLevel: 1,
				badges: [],
			},
		},
		{ upsert: true },
	);

	db.getCollection("user-private-information").updateOne(
		{ userID: userId },
		{
			$set: {
				userID: userId,
				password: PASSWORD_HASH,
				email,
			},
		},
		{ upsert: true },
	);

	db.getCollection("user-settings").updateOne(
		{ userID: userId },
		{
			$set: {
				userID: userId,
				preferences: {
					developerMode: false,
					advancedMode: false,
					invisible: false,
					contentiousContent: false,
					deletableScores: false,
				},
				following: [],
			},
		},
		{ upsert: true },
	);
}

print(`Upserted ${USER_IDS.length} user(s): ${USER_IDS.join(", ")}`);
