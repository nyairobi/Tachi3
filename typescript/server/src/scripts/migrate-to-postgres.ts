/* eslint-disable no-await-in-loop */
/**
 * One-shot migration from MongoDB → PostgreSQL.
 *
 * Fucking wrote by claude dude. I'm out of a job.
 *
 * Required env vars:
 *   MONGO_URL      – MongoDB connection string, e.g. mongodb://mongo/tachi
 *   POSTGRES_URL   – PostgreSQL connection string, e.g. postgresql://tachi:tachi@tachi-postgres/tachi_dev
 *
 * Run with:
 *   cd server && MONGO_URL=... POSTGRES_URL=... ts-node -r tsconfig-paths/register src/scripts/migrate-to-postgres.ts
 */

import type {
	AuthLevel,
	Database,
	GameGroup,
	ImportType,
	NewAccount,
	NewAccountFollowing,
	NewAccountSettings,
	NewAccountUsernameChange,
	NewClassAchievement,
	NewFolderView,
	NewGameProfile,
	NewGameRival,
	NewGameStatsSnapshot,
	NewGoalSub,
	NewImport,
	NewImportClass,
	NewImportError,
	NewImportGame,
	NewImportLock,
	NewImportSession,
	NewImportTiming,
	NewInviteLock,
	NewNotification,
	NewOrphanChart,
	NewOrphanChartUser,
	NewOrphanScore,
	NewPrivAccountCredential,
	NewPrivApiClient,
	NewPrivApiToken,
	NewPrivInvite,
	NewPrivSvcCgCardInfo,
	NewPrivSvcFerCard,
	NewPrivSvcKaiAuthToken,
	NewPrivSvcMytCardInfo,
	NewQuestSub,
	NewScore,
	NewScoreBlacklist,
	NewSession,
	NewSvcFerSettings,
	NewSvcKshookSv6cSettings,
	Game as PgGame,
} from "tachi-db";

import { mongoScoreDataToPg } from "#lib/v3/migration-tools";
import fs from "fs";
import { type Insertable, Kysely, PostgresDialect, sql } from "kysely";
import monk from "monk";
import path from "path";
import { Pool } from "pg";
import {
	ALL_GAMES,
	GameToGameGroup,
	type LEGACY_GPTString,
	LEGACY_GPTStringToGame,
	UserAuthLevels,
	type V3Game,
} from "tachi-common";

import type {
	MongoApiClientsCollectionDocument,
	MongoApiTokensCollectionDocument,
	MongoCgCardInfoCollectionDocument,
	MongoClassAchievementsCollectionDocument,
	MongoFerSettingsCollectionDocument,
	MongoGameSettingsCollectionDocument,
	MongoGameStatsCollectionDocument,
	MongoGameStatsSnapshotsCollectionDocument,
	MongoGoalSubsCollectionDocument,
	MongoImportLocksCollectionDocument,
	MongoImportsCollectionDocument,
	MongoImportTimingsCollectionDocument,
	MongoInviteLocksCollectionDocument,
	MongoInvitesCollectionDocument,
	MongoKaiAuthTokensCollectionDocument,
	MongoKshookSv6cSettingsCollectionDocument,
	MongoMytCardInfoCollectionDocument,
	MongoNotificationsCollectionDocument,
	MongoOrphanChartQueueCollectionDocument,
	MongoOrphanScoresCollectionDocument,
	MongoQuestSubsCollectionDocument,
	MongoRecentFolderViewsCollectionDocument,
	MongoScoreBlacklistCollectionDocument,
	MongoScoresCollectionDocument,
	MongoSessionsCollectionDocument,
	MongoSessionsScoreLookupProjection,
	MongoUserNameChangesCollectionDocument,
	MongoUserPrivateInformationCollectionDocument,
	MongoUsersCollectionDocument,
	MongoUserSettingsCollectionDocument,
} from "./migrate-to-postgres.mongo-docs";

import { buildChartIdMap, importSeeds } from "./load-seeds-pg";

// ──────────────────────────────────────────────────────────────────────────────
// Connection setup
// ──────────────────────────────────────────────────────────────────────────────

const MONGO_URL = process.env.MONGO_URL ?? "mongodb://mongo/tachi";
const POSTGRES_URL = process.env.POSTGRES_URL;
const SEEDS_DIR = process.env.SEEDS_DIR ?? path.resolve(__dirname, "../../../../db/seeds");

if (!POSTGRES_URL) {
	console.error("[migrate] POSTGRES_URL is not set.");
	process.exit(1);
}

const mongoDB = monk(MONGO_URL);

const pg = new Kysely<Database>({
	dialect: new PostgresDialect({
		pool: new Pool({ connectionString: POSTGRES_URL }),
	}),
});

// ──────────────────────────────────────────────────────────────────────────────
// Game helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Games where the Postgres `game` enum equals the game name (single playtype).
 * All other games use `${game}-${playtype.toLowerCase()}`.
 */
const SINGLE_PT_GAMES = new Set([
	"arcaea",
	"chunithm",
	"jubeat",
	"maimai",
	"maimaidx",
	"museca",
	"ongeki",
	"popn",
	"sdvx",
	"wacca",
]);

/** Maps MongoDB game + playtype strings to the Postgres game enum value. */
function toGame(game: string, playtype: string): PgGame {
	if (SINGLE_PT_GAMES.has(game)) {
		return game as PgGame;
	}

	return `${game}-${playtype.toLowerCase()}` as PgGame;
}

/**
 * Handles both legacy Mongo `{ game: GameGroup, playtype }` rows and v3 `{ game: V3Game }` rows.
 */
function mongoGameToPg(game: string, playtype?: string): PgGame {
	if ((ALL_GAMES as readonly string[]).includes(game)) {
		return game as PgGame;
	}
	if (playtype === undefined) {
		throw new Error(`[migrate] Missing playtype for legacy game group: ${game}`);
	}
	return toGame(game, playtype);
}

function mongoImportsCollectionPgGames(imp: MongoImportsCollectionDocument): PgGame[] {
	const gg = imp.game ?? imp.gameGroup;

	if (imp.games !== undefined && imp.games.length > 0) {
		return imp.games.map((g) => mongoGameToPg(g));
	}

	const ptsFromMongo =
		imp.playtypes ??
		(imp.playtype !== undefined && imp.playtype !== "" ? [imp.playtype] : undefined);

	if (ptsFromMongo !== undefined && ptsFromMongo.length > 0 && gg !== undefined) {
		return ptsFromMongo.map((pt) => toGame(gg, pt));
	}

	if (imp.gptStrings !== undefined && imp.gptStrings.length > 0) {
		return imp.gptStrings.map((gpt) =>
			mongoGameToPg(LEGACY_GPTStringToGame(gpt as LEGACY_GPTString)),
		);
	}

	return [];
}

/** Resolves `import.game_group` from legacy aliases or inferred V3 games. */
function mongoImportsCollectionGameGroup(
	imp: MongoImportsCollectionDocument,
	pgGames: PgGame[],
): GameGroup {
	const gg = imp.gameGroup ?? imp.game;
	if (gg !== undefined) {
		return gg;
	}
	const first = pgGames[0];
	if (first !== undefined) {
		return GameToGameGroup(first as V3Game);
	}
	throw new Error(
		`[migrate] import ${imp.importID}: missing game_group (no game/gameGroup and empty derived games list).`,
	);
}

// ──────────────────────────────────────────────────────────────────────────────
// Auth level helper
// ──────────────────────────────────────────────────────────────────────────────

/** Maps the MongoDB numeric UserAuthLevels enum to the Postgres AuthLevel string enum. */
function toAuthLevel(level: UserAuthLevels): AuthLevel {
	switch (level) {
		case UserAuthLevels.BANNED:
			return "banned";
		case UserAuthLevels.ADMIN:
			return "admin";
		default:
			return "user";
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Timestamp helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Convert a millisecond epoch to ISO-8601 string. Returns null if falsy. */
function ts(ms: number | null | undefined): string | null {
	return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/** As above, but required (throws if falsy). */
function tsReq(ms: number): string {
	return new Date(ms).toISOString();
}

// ──────────────────────────────────────────────────────────────────────────────
// API permission helpers
// (Old MongoDB data uses dash-separated permission names, not the underscore
// form in the current APIPermissions type - kept as plain string lookups.)
// ──────────────────────────────────────────────────────────────────────────────

/** Extract one Postgres pm_* column from a MongoDB requestedPermissions array. */
function perm(permissions: Array<string>, key: string): boolean | null {
	return permissions.includes(key) ? true : null;
}

/** Extract one Postgres pm_* column from a MongoDB permissions record. */
function permRec(permissions: Record<string, boolean>, key: string): boolean | null {
	return permissions[key] ?? null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Bulk insert helper
// ──────────────────────────────────────────────────────────────────────────────

const INSERT_CHUNK = 500;

/** JSON text form of U+0000 that JSON.stringify uses; Postgres jsonb rejects this in strings. */
const JSON_TEXT_ESCAPE_U0000 = ["\\", "u0000"].join("");

/**
 * Some chart_id sha256s in fervidex imports have nulbytes at the end; which are illegal in postgres serializations.
 */
function stripNulBytesIllegalInPostgres(s: string): string {
	return s.replaceAll("\u0000", "").replaceAll(JSON_TEXT_ESCAPE_U0000, "");
}

function sanitizeOrphanScoreJsonForPostgres(value: unknown): unknown {
	const json = JSON.stringify(value ?? null);
	const stripped = stripNulBytesIllegalInPostgres(json);
	return JSON.parse(stripped) as unknown;
}

async function batchInsert<T extends keyof Database>(
	table: T,
	rows: ReadonlyArray<Insertable<Database[T]>>,
): Promise<void> {
	if (rows.length === 0) {
		return;
	}

	for (let i = 0; i < rows.length; i = i + INSERT_CHUNK) {
		const chunk = rows.slice(i, i + INSERT_CHUNK);

		// The inner `as never` is an implementation detail: TypeScript cannot narrow
		// generic T inside the function body. The public signature enforces correctness.
		try {
			await pg
				.insertInto(table)
				.values(chunk as never)
				.execute();
		} catch (err) {
			console.error(`  [${table}] Error inserting chunk:`, err);

			fs.writeFileSync(`invalidshit-${table}.json`, JSON.stringify(chunk, null, "\t"));
			throw err;
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Streaming helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Convenience wrapper: cursor-streams a MongoDB collection and inserts all
 * mapped rows into a single Postgres table. For collections with multiple
 * output tables or complex logic, use streamCollection directly.
 */
async function streamMigrate<Doc extends object, Row extends object>(
	collection: string,
	table: keyof Database,
	mapFn: (doc: Doc) => Row,
	label = collection,
	batchSize = 2_000,
): Promise<void> {
	await streamCollection<Doc>(
		collection,
		async (docs) => {
			await batchInsert(table, docs.map(mapFn) as never);
		},
		label,
		batchSize,
	);
}

// ──────────────────────────────────────────────────────────────────────────────
// Cursor-based streaming for large collections (keyset pagination on _id)
// ──────────────────────────────────────────────────────────────────────────────

async function streamCollection<T>(
	collectionName: string,
	onBatch: (docs: Array<T>) => Promise<void>,
	label: string,
	batchSize = 2_000,
): Promise<void> {
	const col = mongoDB.get<{ _id: unknown } & T>(collectionName);
	const total = await col.count({});

	console.log(`  [${label}] ${total.toLocaleString()} documents to migrate...`);

	let lastId: unknown = null;
	let processed = 0;

	while (true) {
		// FilterQuery<T> is structurally strict; cast through unknown to allow raw _id queries.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const query = (lastId !== null ? { _id: { $gt: lastId } } : {}) as any;

		const docs = (await col.find(query, {
			sort: { _id: 1 },
			limit: batchSize,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any)) as unknown as Array<{ _id: unknown } & T>;

		if (docs.length === 0) {
			break;
		}

		await onBatch(docs);

		// docs.length > 0 is guaranteed by the break above

		lastId = docs[docs.length - 1]!._id;
		processed = processed + docs.length;

		if (processed % 100_000 === 0) {
			console.log(`    ${processed.toLocaleString()} / ${total.toLocaleString()}`);
		}
	}

	console.log(`  [${label}] Done: ${processed.toLocaleString()} rows.`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	await mongoDB.then(() => void 0);

	console.log("=== MongoDB → PostgreSQL migration ===\n");

	// ── Seeds first ────────────────────────────────────────────────────────
	// Songs, charts, folders, tables, goals, quests, questlines, and BMS
	// courses all come from the local seeds directory rather than MongoDB.
	console.log("── Seeds ────────────────────────────────────────────────────────");
	await importSeeds(pg, SEEDS_DIR);

	// Maps old MongoDB chartID (40-char SHA1) → seed sid (16-char hex).
	// Used to resolve chart_id FK references in scores and PBs.
	const chartIdMap = buildChartIdMap(SEEDS_DIR);

	// ══════════════════════════════════════════════════════════════════════════
	// LEVEL 0 - No FK dependencies
	// ══════════════════════════════════════════════════════════════════════════

	console.log("\n── Level 0 ──────────────────────────────────────────────────────");

	// ── account + account_badge ───────────────────────────────────────────────
	{
		console.log("\n[account / account_badge]");
		const users = await mongoDB.get<MongoUsersCollectionDocument>("users").find({});

		const accountRows: Array<NewAccount> = users.map((u) => ({
			id: u.id,
			username: u.username,
			sm_discord: u.socialMedia.discord ?? null,
			sm_twitter: u.socialMedia.twitter ?? null,
			sm_github: u.socialMedia.github ?? null,
			sm_steam: u.socialMedia.steam ?? null,
			sm_youtube: u.socialMedia.youtube ?? null,
			sm_twitch: u.socialMedia.twitch ?? null,
			joined: tsReq(u.joinDate),
			about: u.about,
			status: u.status && u.status.length > 140 ? null : u.status,
			custom_pfp_location: u.customPfpLocation,
			custom_banner_location: u.customBannerLocation,
			last_seen: tsReq(u.lastSeen),
			auth_level: toAuthLevel(u.authLevel),
			bd_alpha: u.badges.includes("alpha"),
			bd_beta: u.badges.includes("beta"),
			bd_dev_team: u.badges.includes("dev-team"),
		}));

		await batchInsert("account", accountRows);

		// Reset BIGSERIAL sequence so future inserts don't collide with migrated IDs.
		await sql`SELECT setval(pg_get_serial_sequence('account', 'id'), (SELECT MAX(id) FROM account))`.execute(
			pg,
		);

		console.log(`  ${users.length} accounts.`);
	}

	// ── orphan_chart + orphan_chart_user ──────────────────────────────────────
	{
		console.log("\n[orphan_chart / orphan_chart_user]");
		const migratedAccountIds = new Set(
			(await pg.selectFrom("account").select("id").execute()).map((r) => r.id),
		);

		const orphans = await mongoDB.get<MongoOrphanChartQueueCollectionDocument>(
			"orphan-chart-queue",
		).find({});

		const orphanRows: Array<NewOrphanChart> = [];
		const orphanUserRows: Array<NewOrphanChartUser> = [];
		let skippedOrphanUserLinks = 0;

		for (const o of orphans) {
			const chartId = o.chartDoc.chartID;

			const chartDocGame =
				typeof o.chartDoc.game === "string" && o.chartDoc.game !== ""
					? o.chartDoc.game
					: undefined;

			const gptLike =
				o.gptString !== undefined && o.gptString !== ""
					? o.gptString
					: o.idString !== undefined && o.idString !== ""
						? o.idString
						: undefined;

			const gameSlug =
				(o.game !== undefined && o.game !== "" ? o.game : undefined) ??
				(gptLike !== undefined ? LEGACY_GPTStringToGame(gptLike as LEGACY_GPTString) : undefined) ??
				chartDocGame;

			if (gameSlug === undefined) {
				console.error(
					`[migrate] [orphan_chart] Cannot derive Postgres game for chartID=${chartId}. Raw Mongo orphan-chart-queue document:`,
				);
				console.error(JSON.stringify(o, null, "\t"));

				throw new Error(
					`[migrate] [orphan_chart] ${chartId}: no game (checked root game, gptString, idString, chartDoc.game). Printed document JSON above.`,
				);
			}

			orphanRows.push({
				id: chartId,
				game: mongoGameToPg(gameSlug),
				chart_doc: JSON.stringify(o.chartDoc),
				song_doc: JSON.stringify(o.songDoc),
			});

			for (const userId of o.userIDs ?? []) {
				if (!migratedAccountIds.has(userId)) {
					skippedOrphanUserLinks++;
					continue;
				}

				orphanUserRows.push({ orphan_chart_id: chartId, user_id: userId });
			}
		}

		await batchInsert("orphan_chart", orphanRows);
		await batchInsert("orphan_chart_user", orphanUserRows);

		if (skippedOrphanUserLinks > 0) {
			console.warn(
				`  [orphan_chart_user] Skipped ${skippedOrphanUserLinks.toLocaleString()} user link(s) — user_id not present in migrated account (Mongo referenced deleted/absent users).`,
			);
		}

		console.log(`  ${orphanRows.length} orphan charts, ${orphanUserRows.length} user links.`);
	}

	// ── orphan_score (Mongo orphan-scores) ─────────────────────────────────────
	{
		console.log("\n[orphan_score]");

		const mongoOrphans = await mongoDB
			.get<{ _id?: unknown } & MongoOrphanScoresCollectionDocument>("orphan-scores")
			.find({});

		const orphanScoreRows: Array<NewOrphanScore> = [];
		for (const o of mongoOrphans) {
			const errMsg = stripNulBytesIllegalInPostgres(o.errMsg ?? "");

			orphanScoreRows.push({
				orphan_id: o.orphanID,
				user_id: o.userID,
				import_id: null,
				import_type: o.importType as ImportType,
				game_group: o.game,
				data: sanitizeOrphanScoreJsonForPostgres(o.data),
				context: sanitizeOrphanScoreJsonForPostgres(o.context),
				time_inserted: tsReq(o.timeInserted),
				error_message: errMsg,
			});
		}

		for (let i = 0; i < orphanScoreRows.length; i = i + INSERT_CHUNK) {
			const chunk = orphanScoreRows.slice(i, i + INSERT_CHUNK);

			await pg
				.insertInto("orphan_score")
				.values(chunk)
				.onConflict((oc) => oc.column("orphan_id").doNothing())
				.execute();
		}

		console.log(`  ${mongoOrphans.length} orphan scores (idempotent on orphan_id).`);
	}

	// ══════════════════════════════════════════════════════════════════════════
	// LEVEL 1 - Depend on account and/or level-0 tables
	// ══════════════════════════════════════════════════════════════════════════

	console.log("\n── Level 1 ──────────────────────────────────────────────────────");

	// ── account_settings + account_following ──────────────────────────────────
	{
		console.log("\n[account_settings / account_following]");
		const settings = await mongoDB.get<MongoUserSettingsCollectionDocument>(
			"user-settings",
		).find({});

		const settingRows: Array<NewAccountSettings> = settings.map((s) => ({
			user_id: s.userID,
			pf_invisible: s.preferences.invisible,
			pf_developer_mode: s.preferences.developerMode,
			pf_advanced_mode: s.preferences.advancedMode,
			pf_contentious_content: s.preferences.contentiousContent,
			pf_deletable_scores: s.preferences.deletableScores,
		}));

		await batchInsert("account_settings", settingRows);

		const followRows: Array<NewAccountFollowing> = [];

		for (const s of settings) {
			for (const followeeId of s.following) {
				followRows.push({ user_id: s.userID, followee: followeeId });
			}
		}

		await batchInsert("account_following", followRows);
		console.log(`  ${settings.length} account settings, ${followRows.length} follows.`);
	}

	// ── account_username_change ───────────────────────────────────────────────
	{
		console.log("\n[account_username_change]");
		const changes = await mongoDB.get<MongoUserNameChangesCollectionDocument>(
			"user-name-changes",
		).find({});

		const changeRows: Array<NewAccountUsernameChange> = changes.map((c) => ({
			user_id: c.userID,
			username: c.username,
			previous_username: c.previousUsername,
			timestamp: tsReq(c.timestamp),
		}));

		await batchInsert("account_username_change", changeRows);
		console.log(`  ${changes.length} username changes.`);
	}

	// ── priv_account_credential ───────────────────────────────────────────────
	{
		console.log("\n[priv_account_credential]");
		const privInfo = await mongoDB
			.get<MongoUserPrivateInformationCollectionDocument>("user-private-information")
			.find({});

		const credRows: Array<NewPrivAccountCredential> = privInfo.map((p) => ({
			user_id: p.userID,
			password: p.password,
			email: p.email,
		}));

		await batchInsert("priv_account_credential", credRows);
		console.log(`  ${privInfo.length} credentials.`);
	}

	// ── priv_api_client ───────────────────────────────────────────────────────
	{
		console.log("\n[priv_api_client]");
		const clients = await mongoDB.get<MongoApiClientsCollectionDocument>(
			"api-clients",
		).find({});

		const clientRows: Array<NewPrivApiClient> = clients.map((c) => {
			// Old MongoDB data uses dash-separated permission names ("customise-profile"),
			// not the underscore form in the current APIPermissions type.
			const p = c.requestedPermissions as unknown as Array<string>;

			return {
				client_id: c.clientID,
				client_secret: c.clientSecret,
				name: c.name,
				author: c.author,
				pm_customise_profile: perm(p, "customise-profile"),
				pm_customise_score: perm(p, "customise-score"),
				pm_customise_session: perm(p, "customise-session"),
				pm_delete_score: perm(p, "delete-score"),
				pm_manage_rivals: perm(p, "manage-rivals"),
				pm_manage_targets: perm(p, "manage-targets"),
				pm_submit_score: perm(p, "submit-score"),
				pm_manage_challenges: perm(p, "manage-challenges"),
				api_key_template: c.apiKeyTemplate,
				api_key_filename: c.apiKeyFilename,
			};
		});

		await batchInsert("priv_api_client", clientRows);
		console.log(`  ${clients.length} API clients.`);
	}

	// ── priv_invite ───────────────────────────────────────────────────────────
	{
		console.log("\n[priv_invite]");
		// InviteCodeDocument is a discriminated union; use the full flattened type.
		const invites = await mongoDB.get<MongoInvitesCollectionDocument>("invites").find({});

		const inviteRows: Array<NewPrivInvite> = invites.map((inv) => ({
			code: inv.code,
			created_by: inv.createdBy,
			created_at: tsReq(inv.createdAt),
			consumed: inv.consumed,
			consumed_by: inv.consumedBy,
			consumed_at: ts(inv.consumedAt),
		}));

		await batchInsert("priv_invite", inviteRows);
		console.log(`  ${invites.length} invites.`);
	}

	// ── priv_svc_kai_auth_token ───────────────────────────────────────────────
	{
		console.log("\n[priv_svc_kai_auth_token]");
		const kaiTokens = await mongoDB.get<MongoKaiAuthTokensCollectionDocument>(
			"kai-auth-tokens",
		).find({});

		const tokenRows: Array<NewPrivSvcKaiAuthToken> = kaiTokens.map((k) => ({
			user_id: k.userID,
			service: k.service,
			token: k.token,
			refresh_token: k.refreshToken,
		}));

		await batchInsert("priv_svc_kai_auth_token", tokenRows);
		console.log(`  ${kaiTokens.length} KAI auth tokens.`);
	}

	// ── priv_svc_cg_card_info ─────────────────────────────────────────────────
	{
		console.log("\n[priv_svc_cg_card_info]");
		const cgCards = await mongoDB.get<MongoCgCardInfoCollectionDocument>(
			"cg-card-info",
		).find({});

		const cgRows: Array<NewPrivSvcCgCardInfo> = [];

		for (const c of cgCards) {
			if (c.service !== "dev" && c.service !== "gan" && c.service !== "nag") {
				console.error(`  [priv_svc_cg_card_info] Skipping invalid service: ${c.service}`);
				continue;
			}

			cgRows.push({
				user_id: c.userID,
				service: c.service,
				card_id: c.cardID,
				pin: c.pin,
			});
		}

		await batchInsert("priv_svc_cg_card_info", cgRows);
		console.log(`  ${cgCards.length} CG card infos.`);
	}

	// ── priv_svc_myt_card_info ────────────────────────────────────────────────
	{
		console.log("\n[priv_svc_myt_card_info]");
		const mytCards = await mongoDB.get<MongoMytCardInfoCollectionDocument>(
			"myt-card-info",
		).find({});

		const mytRows: Array<NewPrivSvcMytCardInfo> = [];

		for (const m of mytCards) {
			if (mytRows.find((e) => e.card_access_code === m.cardAccessCode)) {
				console.error(
					`  [priv_svc_myt_card_info] Skipping duplicate card access code: ${m.cardAccessCode}`,
				);
				continue;
			}

			mytRows.push({
				user_id: m.userID,
				card_access_code: m.cardAccessCode,
			});
		}

		await batchInsert("priv_svc_myt_card_info", mytRows);
		console.log(`  ${mytCards.length} MYT card infos.`);
	}

	// ── svc_fer_settings + priv_svc_fer_card ─────────────────────────────────
	{
		console.log("\n[svc_fer_settings / priv_svc_fer_card]");
		const ferSettings = await mongoDB.get<MongoFerSettingsCollectionDocument>(
			"fer-settings",
		).find({});

		const ferRows: Array<NewSvcFerSettings> = ferSettings.map((f) => ({
			user_id: f.userID,
			force_static_import: f.forceStaticImport,
		}));

		await batchInsert("svc_fer_settings", ferRows);

		const cardRows: Array<NewPrivSvcFerCard> = [];

		for (const f of ferSettings) {
			for (const card of f.cards ?? []) {
				cardRows.push({ user_id: f.userID, card_id: card });
			}
		}

		await batchInsert("priv_svc_fer_card", cardRows);
		console.log(`  ${ferSettings.length} fer settings, ${cardRows.length} FER cards.`);
	}

	// ── svc_kshook_sv6c_settings ──────────────────────────────────────────────
	{
		console.log("\n[svc_kshook_sv6c_settings]");
		const ksSettings = await mongoDB
			.get<MongoKshookSv6cSettingsCollectionDocument>("kshook-sv6c-settings")
			.find({});

		const ksRows: Array<NewSvcKshookSv6cSettings> = ksSettings.map((k) => ({
			user_id: k.userID,
			force_static_import: k.forceStaticImport,
		}));

		await batchInsert("svc_kshook_sv6c_settings", ksRows);
		console.log(`  ${ksSettings.length} KsHook settings.`);
	}

	// ── import_lock ───────────────────────────────────────────────────────────
	{
		console.log("\n[import_lock]");
		const importLocks = await mongoDB.get<MongoImportLocksCollectionDocument>(
			"import-locks",
		).find({});

		const lockRows: Array<NewImportLock> = importLocks.map((l) => ({
			user_id: l.userID,
			locked: l.locked,
			locked_at: ts(l.lockedAt),
		}));

		await batchInsert("import_lock", lockRows);
		console.log(`  ${importLocks.length} import locks.`);
	}

	// ── invite_lock ───────────────────────────────────────────────────────────
	{
		console.log("\n[invite_lock]");
		const inviteLocks = await mongoDB.get<MongoInviteLocksCollectionDocument>(
			"invite-locks",
		).find({});

		const lockRows: Array<NewInviteLock> = [];

		for (const l of inviteLocks) {
			if (lockRows.find((e) => e.user_id === l.userID)) {
				console.error(`  [invite_lock] Skipping duplicate user ID: ${l.userID}`);
				continue;
			}

			lockRows.push({
				user_id: l.userID,
				locked: l.locked,
				locked_at: null,
			});
		}

		await batchInsert("invite_lock", lockRows);
		console.log(`  ${inviteLocks.length} invite locks.`);
	}

	// ── notification ──────────────────────────────────────────────────────────
	{
		console.log("\n[notification]");
		const notifications = await mongoDB.get<MongoNotificationsCollectionDocument>(
			"notifications",
		).find({});

		const notifRows: Array<NewNotification> = notifications.map((n) => ({
			title: n.title,
			sent_to: n.sentTo,
			sent_at: tsReq(n.sentAt),
			read: n.read,
			kind: n.body.type.toLowerCase(),
			payload: JSON.stringify(n.body),
		}));

		await batchInsert("notification", notifRows);
		console.log(`  ${notifications.length} notifications.`);
	}

	// ── game_profile + game_rival ───────────────────────────────────────────────
	// Greenfield schema: one `game_profile` row per UGPT (stats + preferences + showcase JSON);
	// see `db/migrations/20260301154256_genesis.sql`. Here we merge legacy Mongo `game-stats` +
	// `game-settings` (+ rivals) into those rows for mongo-to-pg.
	{
		console.log("\n[game_profile / game_rival]");
		const ugptSettings = await mongoDB.get<MongoGameSettingsCollectionDocument>(
			"game-settings",
		).find({});
		const gameStats = await mongoDB.get<MongoGameStatsCollectionDocument>(
			"game-stats",
		).find({});

		type ProfileKey = `${number}:${PgGame}`;
		const profileByKey = new Map<ProfileKey, NewGameProfile>();

		const emptyPrefs = (
			game: PgGame,
		): Pick<
			NewGameProfile,
			| "data"
			| "pf_default_table"
			| "pf_preferred_default_enum"
			| "pf_preferred_profile_alg"
			| "pf_preferred_ranking"
			| "pf_preferred_score_alg"
			| "pf_preferred_session_alg"
			| "showcase"
		> => ({
			pf_preferred_score_alg: null,
			pf_preferred_session_alg: null,
			pf_preferred_profile_alg: null,
			pf_preferred_default_enum: null,
			pf_default_table: null,
			pf_preferred_ranking: null,
			data: JSON.stringify(
				game === "iidx-sp" || game === "iidx-dp"
					? { display2DXTra: false, bpiTarget: 0 }
					: {},
			),
			showcase: JSON.stringify([]),
		});

		for (const gs of gameStats) {
			const game = mongoGameToPg(gs.game, gs.playtype);
			const key = `${gs.userID}:${game}` as ProfileKey;
			profileByKey.set(key, {
				user_id: gs.userID,
				game,
				ratings: JSON.stringify(gs.ratings),
				classes: JSON.stringify(gs.classes),
				...emptyPrefs(game),
			});
		}

		for (const s of ugptSettings) {
			const game = mongoGameToPg(s.game, s.playtype);
			const key = `${s.userID}:${game}` as ProfileKey;
			const prefs = s.preferences;
			const existing = profileByKey.get(key);
			const prefSlice = {
				pf_preferred_score_alg: (prefs.preferredScoreAlg as string | null) ?? null,
				pf_preferred_session_alg: (prefs.preferredSessionAlg as string | null) ?? null,
				pf_preferred_profile_alg: (prefs.preferredProfileAlg as string | null) ?? null,
				pf_preferred_default_enum: prefs.preferredDefaultEnum,
				pf_default_table: prefs.defaultTable,
				pf_preferred_ranking: prefs.preferredRanking,
				data: JSON.stringify(prefs.gameSpecific),
				showcase: JSON.stringify(prefs.stats),
			};
			if (existing) {
				profileByKey.set(key, { ...existing, ...prefSlice });
			} else {
				profileByKey.set(key, {
					user_id: s.userID,
					game,
					ratings: JSON.stringify({}),
					classes: JSON.stringify({}),
					...prefSlice,
				});
			}
		}

		const profileRows = [...profileByKey.values()];
		const rivalRows: Array<NewGameRival> = [];

		for (const s of ugptSettings) {
			const game = mongoGameToPg(s.game, s.playtype);
			for (const rivalId of s.rivals) {
				if (rivalId !== s.userID) {
					rivalRows.push({ user_id: s.userID, game, rival: rivalId });
				}
			}
		}

		await batchInsert("game_profile", profileRows);
		await batchInsert("game_rival", rivalRows);
		console.log(
			`  ${profileRows.length} game profiles (${gameStats.length} stats docs merged with ${ugptSettings.length} settings docs), ${rivalRows.length} rivals.`,
		);
	}

	// ── game_stats_snapshot ───────────────────────────────────────────────────
	console.log("\n[game_stats_snapshot]");
	await streamMigrate<MongoGameStatsSnapshotsCollectionDocument, NewGameStatsSnapshot>(
		"game-stats-snapshots",
		"game_stats_snapshot",
		(snap) => ({
			user_id: snap.userID,
			game: mongoGameToPg(snap.game, snap.playtype),
			timestamp: tsReq(snap.timestamp),
			playcount: snap.playcount,
			ratings: JSON.stringify(snap.ratings),
			classes: JSON.stringify(snap.classes),
			rankings: JSON.stringify(snap.rankings),
		}),
	);

	// ── class_achievement ─────────────────────────────────────────────────────
	{
		console.log("\n[class_achievement]");
		const achievements = await mongoDB.get<MongoClassAchievementsCollectionDocument>(
			"class-achievements",
		).find({});

		const achievementRows: Array<NewClassAchievement> = achievements.map((a) => ({
			game: mongoGameToPg(a.game, a.playtype),
			user_id: a.userID,
			class_set: a.classSet as string,
			class_prev_value:
				a.classOldValue === null || a.classOldValue === undefined
					? ""
					: String(a.classOldValue),
			class_value: String(a.classValue),
			timestamp: tsReq(a.timeAchieved),
		}));

		await batchInsert("class_achievement", achievementRows);
		console.log(`  ${achievements.length} class achievements.`);
	}

	// ── session ───────────────────────────────────────────────────────────────
	console.log("\n[session]");
	await streamCollection<MongoSessionsCollectionDocument>(
		"sessions",
		async (docs) => {
			const rows: Array<NewSession> = [];
			for (const s of docs) {
				const calculated_data = JSON.stringify(s.calculatedData);
				rows.push({
					id: s.sessionID,
					user_id: s.userID,
					game: mongoGameToPg(s.game, s.playtype),
					name: s.name,
					description: s.desc,
					time_inserted: tsReq(s.timeInserted),
					time_started: tsReq(s.timeStarted),
					time_ended: tsReq(s.timeEnded),
					calculated_data,
					highlight: s.highlight,
				});
			}
			await batchInsert("session", rows);
		},
		"sessions",
	);

	// ── import + import_* children ────────────────────────────────────────────
	// Streamed: 2.5M rows. One pass populates the base table and all 6 child
	// tables. Base rows are inserted before children within each batch to
	// satisfy FK constraints.

	// Pre-load all migrated session IDs into memory. The session table is fully
	// populated above and won't change during this loop, so we can filter
	// import_session rows with a local Set instead of issuing a SELECT query
	// on every batch (~1,250 round-trips for a 2.5M-document collection).
	const migratedSessionIds = new Set(
		(await pg.selectFrom("session").select("id").execute()).map((r) => r.id),
	);

	console.log("\n[import / import_game / import_error / import_class / import_session]");
	await streamCollection<MongoImportsCollectionDocument>(
		"imports",
		async (docs) => {
			const importRows: Array<NewImport> = [];
			const importGameRows: Array<NewImportGame> = [];
			const importErrorRows: Array<NewImportError> = [];
			const importClassRows: Array<NewImportClass> = [];
			let importSessionRows: Array<NewImportSession> = [];

			// Batch-fetch the service field from the first score of each import
			// rather than doing one findOne per import document.
			const firstScoreIds = docs
				.map((imp) => imp.scoreIDs?.[0])
				.filter((id): id is string => id !== undefined);

			const scoreServiceMap = new Map(
				(
					await mongoDB
						.get<Pick<MongoScoresCollectionDocument, "scoreID" | "service">>(
							"scores",
						)
						.find(
							{ scoreID: { $in: firstScoreIds } },
							{ projection: { scoreID: 1, service: 1 } },
						)
				).map((s) => [s.scoreID, s.service]),
			);

			for (const imp of docs) {
				const importId = imp.importID;

				const service = scoreServiceMap.get(imp.scoreIDs?.[0] ?? "") ?? "Unknown";
				const derivedGames = mongoImportsCollectionPgGames(imp);
				const gameGroup = mongoImportsCollectionGameGroup(imp, derivedGames);

				importRows.push({
					id: importId,
					user_id: imp.userID,
					time_started: tsReq(imp.timeStarted),
					time_finished: tsReq(imp.timeFinished),
					game_group: gameGroup,
					import_type: (imp.importType ?? "ir/direct-manual") as ImportType,
					user_intent: imp.userIntent ?? false,
					service,
				});

				for (const pgGame of derivedGames) {
					importGameRows.push({ id: importId, game: pgGame });
				}

				for (const err of imp.errors ?? []) {
					importErrorRows.push({
						import_id: importId,
						type: err.type,
						message: err.message,
					});
				}

				for (const delta of imp.classDeltas ?? []) {
					importClassRows.push({
						import_id: importId,
						game: mongoGameToPg(delta.game, delta.playtype),
						set: delta.set as string,
						prev:
							delta.old === null || delta.old === undefined
								? null
								: String(delta.old),
						new: String(delta.new),
					});
				}

				for (const sess of imp.createdSessions ?? []) {
					importSessionRows.push({
						import_id: importId,
						session_id: sess.sessionID,
						type: sess.type.toLowerCase(),
					});
				}
			}

			// Deduplicate import_session rows (same import_id + session_id can appear multiple times).
			const seenImportSession = new Set<string>();

			importSessionRows = importSessionRows.filter((r) => {
				const key = `${r.import_id}:${r.session_id}`;

				if (seenImportSession.has(key)) {
					return false;
				}

				seenImportSession.add(key);
				return true;
			});

			// Filter out import_session rows whose session wasn't migrated.
			if (importSessionRows.length > 0) {
				const before = importSessionRows.length;

				importSessionRows = importSessionRows.filter((r) =>
					migratedSessionIds.has(r.session_id),
				);
				const skipped = before - importSessionRows.length;

				if (skipped > 0) {
					console.warn(
						`  [import_session] Skipped ${skipped} row(s) - session not found`,
					);
				}
			}

			// Base rows first - children have FK references to import(id).
			await batchInsert("import", importRows);
			await batchInsert("import_game", importGameRows);
			await batchInsert("import_error", importErrorRows);
			await batchInsert("import_class", importClassRows);
			await batchInsert("import_session", importSessionRows);
			// import_goal and import_quest are intentionally skipped - the
			// historical data doesn't align with reality.
		},
		"import + children",
	);

	// ── goal_sub ──────────────────────────────────────────────────────────────
	{
		console.log("\n[goal_sub]");
		const goalSubs = await mongoDB.get<MongoGoalSubsCollectionDocument>(
			"goal-subs",
		).find({});

		const uniqueGoalIds = [...new Set(goalSubs.map((gs) => gs.goalID))];
		const existingGoalIds = new Set(
			uniqueGoalIds.length === 0
				? []
				: (
						await pg
							.selectFrom("goal")
							.select("id")
							.where("id", "in", uniqueGoalIds)
							.execute()
					).map((r) => r.id),
		);

		const goalSubRows: Array<NewGoalSub> = [];

		for (const gs of goalSubs) {
			if (!existingGoalIds.has(gs.goalID)) {
				console.warn(`  [goal_sub] Skipping - goal ${gs.goalID} not found in DB`);
				continue;
			}

			goalSubRows.push({
				goal_id: gs.goalID,
				user_id: gs.userID,
				last_interaction: ts(gs.lastInteraction),
				progress: gs.progress,
				progress_human: gs.progressHuman,
				out_of: gs.outOf,
				out_of_human: gs.outOfHuman,
				achieved: gs.achieved,
				time_achieved: ts(gs.timeAchieved),
				was_instantly_achieved: gs.wasInstantlyAchieved,
				was_assigned_standalone: gs.wasAssignedStandalone,
			});
		}

		await batchInsert("goal_sub", goalSubRows);
		console.log(
			`  ${goalSubRows.length} goal subscriptions (${
				goalSubs.length - goalSubRows.length
			} skipped).`,
		);
	}

	// ── quest_sub ─────────────────────────────────────────────────────────────
	{
		console.log("\n[quest_sub]");
		const questSubs = await mongoDB.get<MongoQuestSubsCollectionDocument>(
			"quest-subs",
		).find({});

		const questSubRows: Array<NewQuestSub> = questSubs.map((qs) => ({
			quest_id: qs.questID,
			user_id: qs.userID,
			progress: qs.progress,
			last_interaction: ts(qs.lastInteraction),
			achieved: qs.achieved,
			time_achieved: ts(qs.timeAchieved),
			was_instantly_achieved: qs.wasInstantlyAchieved,
		}));

		await batchInsert("quest_sub", questSubRows);
		console.log(`  ${questSubs.length} quest subscriptions.`);
	}

	// ── folder_view ───────────────────────────────────────────────────────────
	{
		const folderViews = await mongoDB
			.get<MongoRecentFolderViewsCollectionDocument>("recent-folder-views")
			.find({});

		const uniqueFolderIds = [...new Set(folderViews.map((fv) => fv.folderID))];
		const existingFolderIds = new Set(
			(
				await pg
					.selectFrom("folder")
					.select("id")
					.where("id", "in", uniqueFolderIds)
					.execute()
			).map((r) => r.id),
		);

		const viewRows: Array<NewFolderView> = folderViews
			.filter((fv) => existingFolderIds.has(fv.folderID))
			.map((fv) => ({
				user_id: fv.userID,
				folder_id: fv.folderID,
				last_viewed: tsReq(fv.lastViewed),
			}));

		const skipped = folderViews.length - viewRows.length;

		if (skipped > 0) {
			console.warn(`  [folder_view] Skipping ${skipped} row(s) - folder not found in DB`);
		}

		for (let i = 0; i < viewRows.length; i = i + INSERT_CHUNK) {
			const chunk = viewRows.slice(i, i + INSERT_CHUNK);

			await pg
				.insertInto("folder_view")
				.values(chunk)
				.onConflict((oc) =>
					oc.columns(["user_id", "folder_id"]).doUpdateSet({
						last_viewed: sql`excluded.last_viewed`,
					}),
				)
				.execute();
		}

		console.log(`  ${viewRows.length} folder views (${skipped} skipped).`);
	}

	// ── score_blacklist ───────────────────────────────────────────────────────
	{
		console.log("\n[score_blacklist]");
		const blacklist = await mongoDB
			.get<MongoScoreBlacklistCollectionDocument>("score-blacklist")
			.find({});

		const blacklistRows: Array<NewScoreBlacklist> = blacklist.map((b) => ({
			user_id: b.userID,
			score_id: b.scoreID,
		}));

		await batchInsert("score_blacklist", blacklistRows);
		console.log(`  ${blacklist.length} score blacklist entries.`);
	}

	// ══════════════════════════════════════════════════════════════════════════
	// LEVEL 2 - Depend on level 1 tables
	// ══════════════════════════════════════════════════════════════════════════

	console.log("\n── Level 2 ──────────────────────────────────────────────────────");

	// ── priv_api_token ────────────────────────────────────────────────────────
	{
		console.log("\n[priv_api_token]");
		const apiTokens = await mongoDB
			.get<MongoApiTokensCollectionDocument>("api-tokens")
			.find({});

		const existingClientIds = new Set(
			(await pg.selectFrom("priv_api_client").select("client_id").execute()).map(
				(r) => r.client_id,
			),
		);

		const validTokens = apiTokens.filter(
			// Skip tokens with no token string (can't be stored as PK) or no user (no FK target).
			// Also skip tokens whose oauth2 client no longer exists.
			(t) =>
				t.token !== null &&
				t.userID !== null &&
				(t.fromAPIClient === null || existingClientIds.has(t.fromAPIClient)),
		);

		if (validTokens.length !== apiTokens.length) {
			console.warn(
				`  ${
					apiTokens.length - validTokens.length
				} API tokens skipped - null token/userID or deleted oauth2 client`,
			);
		}

		const tokenRows: Array<NewPrivApiToken> = validTokens.map((t) => {
			// Old data uses dash-separated permission names.
			const p = t.permissions;

			return {
				// Guaranteed non-null by the filter above.

				token: t.token!,

				user_id: t.userID!,
				identifier: t.identifier,
				pm_customise_profile: permRec(p, "customise-profile"),
				pm_customise_score: permRec(p, "customise-score"),
				pm_customise_session: permRec(p, "customise-session"),
				pm_delete_score: permRec(p, "delete-score"),
				pm_manage_rivals: permRec(p, "manage-rivals"),
				pm_manage_targets: permRec(p, "manage-targets"),
				pm_submit_score: permRec(p, "submit-score"),
				pm_manage_challenges: permRec(p, "manage-challenges"),
				from_oauth2_client: t.fromAPIClient,
			};
		});

		await batchInsert("priv_api_token", tokenRows);

		console.log(
			`  ${validTokens.length} API tokens (${apiTokens.length - validTokens.length} skipped).`,
		);
	}

	// ── import_timing ─────────────────────────────────────────────────────────
	console.log("\n[import_timing]");
	await streamCollection<MongoImportTimingsCollectionDocument>(
		"import-timings",
		async (docs) => {
			const importIds = docs.map((t) => t.importID);
			const existingIds = new Set(
				(
					await pg
						.selectFrom("import")
						.select("id")
						.where("id", "in", importIds)
						.execute()
				).map((r) => r.id),
			);

			const rows: Array<NewImportTiming> = [];
			let skipped = 0;

			for (const t of docs) {
				if (!existingIds.has(t.importID)) {
					skipped++;
					continue;
				}

				rows.push({
					id: t.importID,
					timestamp: tsReq(t.timestamp),
					import_secs_avg: t.rel.import,
					import_parse_secs_avg: t.rel.importParse,
					pb_secs_avg: t.rel.pb,
					session_secs_avg: t.rel.session,

					parse_secs: t.abs.parse ?? 0,

					import_secs: t.abs.import ?? 0,

					import_parse_secs: t.abs.importParse ?? 0,

					session_secs: t.abs.session ?? 0,

					pb_secs: t.abs.pb ?? 0,

					ugs_secs: t.abs.ugs ?? 0,

					goal_secs: t.abs.goal ?? 0,

					quest_secs: t.abs.quest ?? 0,

					total_secs: t.total ?? 0,
				});
			}

			if (skipped > 0) {
				console.warn(`  [import_timing] Skipped ${skipped} row(s) - import not found`);
			}

			await batchInsert("import_timing", rows);
		},
		"import_timing",
	);

	// ══════════════════════════════════════════════════════════════════════════
	// LEVEL 3 - Large collections: scores and PBs (cursor-streamed)
	// ══════════════════════════════════════════════════════════════════════════

	console.log("\n── Level 3 (streaming) ──────────────────────────────────────────");

	// ── score ─────────────────────────────────────────────────────────────────
	console.log("\n[score]");

	await streamCollection<MongoScoresCollectionDocument>(
		"scores",
		async (docs) => {
			const rows: Array<NewScore> = [];

			// Batch-fetch sessions and imports that contain any score in this
			// batch, then build scoreID→sessionID / scoreID→importID reverse maps.
			// This replaces two individual findOne queries per score with two
			// batch queries per batch (2 round-trips instead of 2×batchSize).
			const batchScoreIds = docs.map((s) => s.scoreID);

			const scoreToSession = new Map<string, string>();
			const scoreToImport = new Map<string, string>();

			const [sessionDocs, importDocs] = await Promise.all([
				mongoDB.get<MongoSessionsScoreLookupProjection>("sessions").find(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					{ scoreIDs: { $in: batchScoreIds } } as any,
					{ projection: { sessionID: 1, scoreIDs: 1 } },
				),
				mongoDB.get<MongoImportsCollectionDocument>("imports").find(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					{ scoreIDs: { $in: batchScoreIds } } as any,
					{ projection: { importID: 1, scoreIDs: 1 } },
				),
			]);

			for (const sess of sessionDocs) {
				for (const sid of sess.scoreIDs) {
					if (!scoreToSession.has(sid)) {
						scoreToSession.set(sid, sess.sessionID);
					}
				}
			}

			for (const imp of importDocs) {
				for (const sid of imp.scoreIDs ?? []) {
					if (!scoreToImport.has(sid)) {
						scoreToImport.set(sid, imp.importID);
					}
				}
			}

			for (const s of docs) {
				const chartSid = chartIdMap.get(s.chartID);

				if (chartSid === undefined) {
					throw new Error(
						`  [score] Skipping score ${s.scoreID} - no sid for chartID ${s.chartID}`,
					);
				}

				const sessionId = scoreToSession.get(s.scoreID) ?? null;
				const importId = scoreToImport.get(s.scoreID) ?? null;

				// if (!sessionId) {
				// console.warn(`  [score] ${s.scoreID} belongs to no session!`);
				// }

				// if (!importId) {
				// console.warn(`  [score] ${s.scoreID} belongs to no import!`);
				// }

				if (!s.scoreData.optional) {
					// obscure corrupt data, one score has no "optional" data?
					s.scoreData.optional = { enumIndexes: {} };
				}

				const v3Game = mongoGameToPg(s.game, s.playtype);
				const { data, derived, judgements } = mongoScoreDataToPg(v3Game, s.scoreData);

				rows.push({
					id: s.scoreID,
					user_id: s.userID,
					chart_id: chartSid,
					game: v3Game,
					session_id: sessionId,
					import_id: importId,
					data: JSON.stringify(data),
					derived_data: JSON.stringify(derived),
					judgements: JSON.stringify(judgements),
					calculated_data: JSON.stringify(s.calculatedData),
					meta: JSON.stringify(s.scoreMeta),
					time_achieved: ts(s.timeAchieved),
					time_added: tsReq(s.timeAdded),
					committed: true,
					highlight: s.highlight,
					comment: s.comment,
				});
			}

			await pg
				.insertInto("score")
				.values(rows as never)
				.execute();
		},
		"score",
	);

	// ── pb + pb_composed_from ─────────────────────────────────────────────────
	console.log("\n[pb / pb_composed_from]");

	console.log("  TODO: Call reprocess-all-pbs somehow.");

	// ══════════════════════════════════════════════════════════════════════════
	// Done
	// ══════════════════════════════════════════════════════════════════════════

	console.log("\n\n=== Migration complete! ===");
}

main()
	.catch((err: unknown) => {
		const message =
			typeof err === "object" && err !== null && "message" in err
				? (err as { message: unknown }).message
				: err;

		console.error("[migrate] Fatal:", message);
		console.error(err);
		process.exit(1);
	})
	.finally(async () => {
		await mongoDB.close();
		await pg.destroy();
	});
