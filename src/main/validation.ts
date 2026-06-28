import { z } from 'zod';

/**
 * IPC input validation for the main process.
 *
 * When BACKEND_API_URL is configured, renderer input is validated server-side
 * by the zod schemas in `server/schemas.ts`. When the app runs in
 * local-database mode, IPC handlers feed renderer input straight into
 * file-system, process-spawning, and database operations, so the same kinds of
 * constraints are enforced here.
 *
 * These schemas are deliberately kept independent of `server/schemas.ts`
 * (small pieces such as the mod-loader enum are duplicated on purpose): the
 * compiled main process must not pull `server/` sources into its `dist/`
 * output (`tsconfig.json` only includes `src/**`, `index.ts`, `preload.ts`).
 */

/**
 * Sanitizes a modpack name for use as an on-disk instance directory name.
 * Returns the safe name, or null when the input is unusable.
 * (Moved from index.ts; single source of truth for instance-path safety.)
 */
export function validateSafeName(name: string): string | null {
    if (!name || typeof name !== 'string') return null;
    const safe = name.replace(/[^a-z0-9_\- ]/gi, '_').trim();
    if (safe.length === 0 || safe.length > 255) return null;
    return safe;
}

/**
 * Validates a bare mod file name (as reported by a provider or read from the
 * instance mods dir) before it is joined onto an instance path. Must be a
 * single path segment: no separators, no traversal, no NUL bytes, sane length.
 */
export function isSafeModFileName(fileName: unknown): fileName is string {
    if (typeof fileName !== 'string') return false;
    if (fileName.length === 0 || fileName.length > 255) return false;
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) return false;
    if (fileName === '.' || fileName === '..') return false;
    return true;
}

/** Mirrors `modLoaderSchema` in server/schemas.ts (kept independent on purpose). */
export const modLoaderSchema = z.enum(['forge', 'neoforge', 'fabric', 'quilt']);

/** Minecraft / loader version strings, e.g. "1.21.1", "0.16.9", "1.20.1-47.2.0". */
export const versionStringSchema = z.string().regex(/^[\w.\-+]{1,64}$/);

/** Game catalog ids are small positive integers (see src/config/games.ts). */
export const gameIdSchema = z.number().int().min(1).max(1_000_000);

/**
 * Mod ids arrive as strings, provider-prefixed: `mr:<projectId>` (Modrinth),
 * `ts:<namespace-name>` (Thunderstore), `sw:<appId>/<pubFileId>` (Steam
 * Workshop), and `cf:<modId>` (CurseForge). `sw:` carries a `/` separator. The
 * length cap fits the longest (Thunderstore `namespace-name`) ids; a single
 * over-long id must not invalidate (and so fail) the whole batch. Provider
 * modules re-validate each id's exact shape via parseModId.
 */
export const modIdsSchema = z.array(z.string().regex(/^(mr:|ts:|sw:|cf:)?[\w/-]{1,160}$/)).max(1000);

/** Allowed memory allocation bounds in MB (matches the existing clamp range). */
export const memoryMbSchema = z.number().finite().min(1024).max(65536);

/**
 * Gate for the memory-setting handler: out-of-range values are clamped (not
 * rejected) to preserve the existing handler contract, so only finiteness is
 * validated up front.
 */
export const finiteNumberSchema = z.number().finite();

/** Loader name as displayed/sent by the renderer for mod searches (e.g. "Forge"). */
export const looseModLoaderNameSchema = z.string().min(1).max(64);

/** Parameters accepted by installLoader / checkLoaderInstalled / getLoaderVersions. */
export const loaderInstallParamsSchema = z.object({
    modLoader: modLoaderSchema,
    minecraftVersion: versionStringSchema,
    loaderVersion: versionStringSchema,
});

/**
 * Loose structural validation for modpack payloads.
 * Unknown extra fields are passed through untouched (the database layer / the
 * backend decide what to persist), but known fields must have sane types so
 * malformed input cannot reach file or database operations. The validated
 * value is only used as a gate; handlers keep forwarding the original object
 * so no coercion changes what gets stored.
 */
export const modpackCreateInputSchema = z.looseObject({
    name: z.string().trim().min(1).max(255),
    gameID: z.coerce.number().finite(),
    description: z.string().optional(),
    mods: z.array(z.string()).optional(),
    // `contributers` is intentionally not declared: the local database layer
    // accepts both plain records and Maps and normalizes them itself.
    minecraftVersion: versionStringSchema.optional(),
    modLoader: modLoaderSchema.optional(),
    loaderVersion: versionStringSchema.optional(),
    memoryAllocationMb: memoryMbSchema.optional(),
    forgeVersion: z.string().optional(),
    // Optional custom icon as a data: URL (Pro). Bounded so an oversized image
    // can't bloat the request; the backend re-validates format + Pro entitlement.
    icon: z.string().max(700000).optional(),
});

/**
 * Gate for checkModUpdates / updateMods. A real name
 * (validateSafeName is applied on top before any filesystem use), a bounded
 * mods array of well-formed ids, and a Minecraft version (the update check is
 * Minecraft-only). The loader is the lowercase enum stored on the modpack.
 */
export const modpackUpdateCheckInputSchema = z.looseObject({
    name: z.string().trim().min(1).max(255),
    gameID: z.coerce.number().finite().optional(),
    mods: modIdsSchema,
    minecraftVersion: versionStringSchema,
    modLoader: modLoaderSchema.optional(),
});

export const modpackUpdateInputSchema = z.looseObject({
    _id: z.string().min(1),
    name: z.string().trim().min(1).max(255).optional(),
    gameID: z.coerce.number().finite().optional(),
    description: z.string().nullish(),
    mods: z.array(z.string()).optional(),
    // These come straight off the stored modpack, which may carry explicit
    // nulls (e.g. a vanilla pack with forgeVersion: null), so accept null too.
    minecraftVersion: versionStringSchema.nullish(),
    modLoader: modLoaderSchema.nullish(),
    loaderVersion: versionStringSchema.nullish(),
    memoryAllocationMb: memoryMbSchema.nullish(),
    customJvmArgs: z.string().max(2000).nullish(),
    forgeVersion: z.string().nullish(),
    // Optional custom icon as a data: URL (Pro). Bounded; '' clears it. The
    // backend re-validates format + Pro entitlement.
    icon: z.string().max(700000).nullish(),
});

/** Convenience helper: true when the value matches the schema. */
export function isValid(schema: z.ZodType, value: unknown): boolean {
    return schema.safeParse(value).success;
}
