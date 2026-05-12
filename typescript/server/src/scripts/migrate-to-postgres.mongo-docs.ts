/**
 * MongoDB document shapes for {@link ./migrate-to-postgres.ts}.
 *
 * These intentionally do **not** match normalized API / `tachi-common` document
 * types: legacy rows use `game` as a **game group** plus `playtype`, and many
 * fields are optional or nullable compared to current validation.
 *
 * Primary spec reference: `PRE_SCHEMAS` in `typescript/common/src/lib/schemas.ts`
 * (collection keys match Mongo collection names where applicable).
 */

import type { ScoreData, V3Game } from "tachi-common";
import type { GameGroup } from "tachi-db";

// ─── api-clients ─────────────────────────────────────────────────────────────

export interface MongoApiClientsCollectionDocument {
	clientID: string;
	clientSecret: string;
	name: string;
	author: number;
	requestedPermissions: Array<string>;
	apiKeyTemplate: string | null;
	apiKeyFilename: string | null;
}

// ─── api-tokens ──────────────────────────────────────────────────────────────

/** Stored field names follow server usage (`fromAPIClient`); see PRE_SCHEMAS for idealized names. */
export interface MongoApiTokensCollectionDocument {
	fromAPIClient: string | null;
	identifier: string;
	permissions: Record<string, boolean>;
	token: string | null;
	userID: number | null;
}

// ─── cg-card-info ────────────────────────────────────────────────────────────

export interface MongoCgCardInfoCollectionDocument {
	userID: number;
	service: string;
	cardID: string;
	pin: string;
}

// ─── class-achievements ──────────────────────────────────────────────────────

export interface MongoClassAchievementsCollectionDocument {
	userID: number;
	/** Game group (not V3 slug) in legacy Mongo. */
	game: string;
	playtype: string;
	classSet: string;
	classOldValue: number | null;
	classValue: number;
	timeAchieved: number;
}

// ─── fer-settings ────────────────────────────────────────────────────────────

export interface MongoFerSettingsCollectionDocument {
	userID: number;
	cards?: Array<string> | null;
	forceStaticImport: boolean;
}

// ─── game-stats ───────────────────────────────────────────────────────────────

export interface MongoGameStatsCollectionDocument {
	userID: number;
	game: string;
	playtype?: string;
	ratings: Record<string, number | null>;
	classes: Record<string, number | null | undefined>;
}

// ─── game-stats-snapshots ────────────────────────────────────────────────────

export interface MongoGameStatsSnapshotsCollectionDocument {
	userID: number;
	game: string;
	playtype?: string;
	timestamp: number;
	playcount: number;
	ratings: Record<string, number | null>;
	classes: Record<string, number | null | undefined>;
	rankings: Record<string, { outOf: number; ranking: number }>;
}

// ─── game-settings (UGPT) ────────────────────────────────────────────────────

export interface MongoGameSettingsCollectionDocument {
	userID: number;
	game: string;
	playtype?: string;
	rivals: Array<number>;
	preferences: {
		defaultTable: string | null;
		gameSpecific: unknown;
		preferredDefaultEnum: "grade" | "lamp" | null;
		preferredProfileAlg: string | null;
		preferredRanking: "global" | "rival" | null;
		preferredScoreAlg: string | null;
		preferredSessionAlg: string | null;
		stats: unknown;
	};
}

// ─── goal-subs ───────────────────────────────────────────────────────────────

export interface MongoGoalSubsCollectionDocument {
	goalID: string;
	userID: number;
	game: string;
	playtype: string;
	achieved: boolean;
	timeAchieved: number | null;
	lastInteraction: number | null;
	progress: number | null;
	progressHuman: string;
	outOf: number;
	outOfHuman: string;
	wasInstantlyAchieved: boolean;
	wasAssignedStandalone: boolean;
}

// ─── import-locks ────────────────────────────────────────────────────────────

export interface MongoImportLocksCollectionDocument {
	userID: number;
	locked: boolean;
	lockedAt: number | null;
}

// ─── import-timings ───────────────────────────────────────────────────────────

export interface MongoImportTimingsCollectionDocument {
	importID: string;
	timestamp: number;
	total: number;
	rel: {
		import: number;
		importParse: number;
		pb: number;
		session: number;
	};
	abs: {
		goal?: number;
		import?: number;
		importParse?: number;
		parse?: number;
		pb?: number;
		quest?: number;
		session?: number;
		ugs?: number;
	};
}

// ─── imports ─────────────────────────────────────────────────────────────────

export interface MongoImportsCollectionDocument {
	importID: string;
	userID: number;
	timeStarted: number;
	timeFinished: number;
	scoreIDs?: Array<string>;

	/** Legacy field name — game group, not V3 slug. */
	game?: GameGroup;
	gameGroup?: GameGroup;

	/** Oldest-era composite keys; see LEGACY_GPTStringToGame. */
	gptStrings?: Array<string>;

	/** Legacy list of playtypes for `game` / `gameGroup`. */
	playtypes?: Array<string>;

	/** Some eras store one playtype string instead of a `playtypes` array. */
	playtype?: string;

	/** New-era V3 game slugs (API ImportDocument.games). */
	games?: Array<string>;

	errors?: Array<{ message: string; type: string }>;
	classDeltas?: Array<{
		game: string;
		new: number | string;
		old?: number | string | null;
		playtype?: string;
		set: string;
	}>;
	createdSessions?: Array<{ sessionID: string; type: string }>;
	importType?: string | null;
	userIntent?: boolean;
}

// ─── invite-locks ────────────────────────────────────────────────────────────

export interface MongoInviteLocksCollectionDocument {
	userID: number;
	locked: boolean;
}

// ─── invites ─────────────────────────────────────────────────────────────────

export interface MongoInvitesCollectionDocument {
	code: string;
	createdBy: number;
	createdAt: number;
	consumed: boolean;
	consumedBy: number | null;
	consumedAt: number | null;
}

// ─── kai-auth-tokens ───────────────────────────────────────────────────────────

export interface MongoKaiAuthTokensCollectionDocument {
	userID: number;
	service: string;
	token: string;
	refreshToken: string;
}

// ─── kshook-sv6c-settings ────────────────────────────────────────────────────

export interface MongoKshookSv6cSettingsCollectionDocument {
	userID: number;
	forceStaticImport: boolean;
}

// ─── myt-card-info ─────────────────────────────────────────────────────────────

export interface MongoMytCardInfoCollectionDocument {
	userID: number;
	cardAccessCode: string;
}

// ─── notifications ─────────────────────────────────────────────────────────────

export interface MongoNotificationsCollectionDocument {
	title: string;
	sentTo: number;
	sentAt: number;
	read: boolean;
	body: { [key: string]: unknown; type: string };
}

// ─── orphan-chart-queue ──────────────────────────────────────────────────────

export interface MongoOrphanChartQueueCollectionDocument {
	/** `game:playtype` composite; current schema name in PRE_SCHEMAS. */
	gptString?: string;
	/** Same semantics as {@link gptString} on older Mongo rows (e.g. USC orphans). */
	idString?: string;
	/** V3 slug or denormalized game field when present on the envelope. */
	game?: string;
	/** Embedding often matches {@link ChartDocument}; `game` lives here even when absent at root. */
	chartDoc: { chartID: string; game?: string } & Record<string, unknown>;
	songDoc: unknown;
	userIDs: Array<number>;
}

// ─── orphan-scores ─────────────────────────────────────────────────────────────

export interface MongoOrphanScoresCollectionDocument {
	orphanID: string;
	importType: string;
	game: GameGroup;
	userID: number;
	timeInserted: number;
	errMsg?: string | null;
	data: unknown;
	context: unknown;
}

// ─── quest-subs ──────────────────────────────────────────────────────────────

export interface MongoQuestSubsCollectionDocument {
	questID: string;
	userID: number;
	game: string;
	playtype: string;
	achieved: boolean;
	timeAchieved: number | null;
	progress: number;
	lastInteraction: number | null;
	wasInstantlyAchieved: boolean;
}

// ─── recent-folder-views ─────────────────────────────────────────────────────

export interface MongoRecentFolderViewsCollectionDocument {
	userID: number;
	folderID: string;
	lastViewed: number;
	game?: string;
	playtype?: string;
}

// ─── score-blacklist ─────────────────────────────────────────────────────────

export interface MongoScoreBlacklistCollectionDocument {
	scoreID: string;
	userID: number;
}

// ─── scores ──────────────────────────────────────────────────────────────────

export interface MongoScoresCollectionDocument {
	scoreID: string;
	service: string;
	/** Game group or V3 slug depending on era. */
	game: string;
	playtype?: string;
	userID: number;
	songID: number;
	chartID: string;
	isPrimary: boolean;
	highlight: boolean;
	comment: string | null;
	timeAdded: number;
	importType: string | null;
	timeAchieved: number | null;
	scoreData: ScoreData<V3Game>;
	scoreMeta: Record<string, unknown>;
	calculatedData: Partial<Record<string, number | null>>;
}

// ─── sessions ────────────────────────────────────────────────────────────────

export interface MongoSessionsCollectionDocument {
	sessionID: string;
	userID: number;
	name: string;
	desc: string | null;
	game: string;
	playtype?: string;
	timeInserted: number;
	timeEnded: number;
	timeStarted: number;
	highlight: boolean;
	calculatedData: Record<string, number | null | undefined>;
	scoreIDs: Array<string>;
}

/** Projection used when resolving score → session from Mongo. */
export type MongoSessionsScoreLookupProjection = Pick<
	MongoSessionsCollectionDocument,
	"scoreIDs" | "sessionID"
>;

// ─── user-name-changes ────────────────────────────────────────────────────────

export interface MongoUserNameChangesCollectionDocument {
	userID: number;
	username: string;
	previousUsername: string;
	timestamp: number;
}

// ─── user-private-information ────────────────────────────────────────────────

export interface MongoUserPrivateInformationCollectionDocument {
	userID: number;
	password: string;
	email: string;
}

// ─── user-settings ───────────────────────────────────────────────────────────

export interface MongoUserSettingsCollectionDocument {
	userID: number;
	following: Array<number>;
	preferences: {
		advancedMode: boolean;
		contentiousContent: boolean;
		deletableScores: boolean;
		developerMode: boolean;
		invisible: boolean;
	};
}

// ─── users ───────────────────────────────────────────────────────────────────

export interface MongoUsersCollectionDocument {
	id: number;
	username: string;
	socialMedia: {
		discord: string | null;
		github: string | null;
		steam: string | null;
		twitch: string | null;
		twitter: string | null;
		youtube: string | null;
	};
	joinDate: number;
	about: string;
	status: string | null;
	customPfpLocation: string | null;
	customBannerLocation: string | null;
	lastSeen: number;
	badges: Array<string>;
	authLevel: number;
}
