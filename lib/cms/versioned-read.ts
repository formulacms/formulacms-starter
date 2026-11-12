import { isSiteLanguageVersionChanged, withCmsCache } from "./cache"
import { CMS_TAGS } from "./tags"

export const PUBLIC_READ_RETRY_AFTER_SECONDS = 3

export class PublicLanguageVersionUnavailableError extends Error {
  readonly status = 503
  readonly retryAfter = PUBLIC_READ_RETRY_AFTER_SECONDS
  readonly cacheControl = "no-store"

  constructor(cause: unknown) {
    super("The public language changed while this response was being read.", {
      cause,
    })
    this.name = "PublicLanguageVersionUnavailableError"
  }
}

/**
 * Run one public response against one committed language version. A stale
 * config/read pair is retried once from a fresh config read, which receives
 * the version it replaces. A second mismatch is surfaced as an explicitly
 * non-cacheable 503 contract error.
 */
export async function withVersionPinnedConfig<
  Config extends { languageVersion: number },
  Result,
>(options: {
  loadConfig: () => Promise<Config>
  loadFreshConfig: (staleVersion: number) => Promise<Config>
  run: (config: Config) => Promise<Result>
  refreshWhen?: (config: Config) => boolean
}): Promise<Result> {
  let config = await options.loadConfig()
  if (options.refreshWhen?.(config)) {
    config = await options.loadFreshConfig(config.languageVersion)
  }

  try {
    return await options.run(config)
  } catch (error) {
    if (!isSiteLanguageVersionChanged(error)) throw error
  }

  const fresh = await options.loadFreshConfig(config.languageVersion)
  try {
    return await options.run(fresh)
  } catch (error) {
    if (!isSiteLanguageVersionChanged(error)) throw error
    throw new PublicLanguageVersionUnavailableError(error)
  }
}

class UnchangedConfigVersion<Config> extends Error {
  constructor(readonly config: Config) {
    super("Site configuration still reports the version being replaced.")
    this.name = "UnchangedConfigVersion"
  }
}

/**
 * The fresh config read for an ISR public route. Convex's `fetchQuery` is
 * always `no-store`, so calling it bare inside an ISR render fails the request
 * with DYNAMIC_SERVER_USAGE (a 500 under `next start`). This keeps the read in
 * the Data Cache like every other public read, keyed by the version it
 * replaces so it can never answer from the stale `cms-config` entry.
 *
 * A read that still reports that version is returned but not stored (a thrown
 * callback stores nothing), so the key only ever holds a newer version.
 * Activation purges it through the settings tag.
 */
export async function readFreshConfig<
  Config extends { languageVersion: number },
>(read: () => Promise<Config>, staleVersion: number): Promise<Config> {
  try {
    return await withCmsCache(
      async () => {
        const config = await read()
        if (config.languageVersion === staleVersion) {
          throw new UnchangedConfigVersion(config)
        }
        return config
      },
      ["cms-config", "after", String(staleVersion)],
      [CMS_TAGS.settings]
    )
  } catch (error) {
    if (error instanceof UnchangedConfigVersion) return error.config as Config
    throw error
  }
}
