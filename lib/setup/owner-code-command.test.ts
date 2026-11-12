import { describe, expect, test } from "vitest"
import {
  buildLiveOwnerCodeCommand,
  buildOwnerCodeCommand,
  convexCloudDeploymentName,
  resolveOwnerCodeTarget,
  shellQuote,
} from "./owner-code-command"

describe("owner code command", () => {
  test("starts in the site folder and names the deployment", () => {
    expect(buildOwnerCodeCommand("/Users/ada/my-site", "happy-animal-123"))
      .toBe(`(
  cd '/Users/ada/my-site' &&
  FORMULACMS_OWNER_CLAIM_VALUE="$(openssl rand -hex 32)" &&
  printf '%s' "$FORMULACMS_OWNER_CLAIM_VALUE" | npx convex env set FORMULACMS_OWNER_CLAIM --deployment happy-animal-123 &&
  printf '%s\\n' "$FORMULACMS_OWNER_CLAIM_VALUE"
)`)
  })

  test("escapes a single quote in the folder as '\\''", () => {
    expect(shellQuote("/Users/o'brien/site")).toBe(`'/Users/o'\\''brien/site'`)
    expect(buildOwnerCodeCommand("/a/it's", "x-1")).toContain(
      `cd '/a/it'\\''s' &&`
    )
  })

  test("is bound to the folder and deployment in local development", () => {
    const target = resolveOwnerCodeTarget(
      { NODE_ENV: "development", CONVEX_DEPLOYMENT: "dev:happy-animal-123" },
      "/srv/site"
    )
    expect(target).toEqual({
      kind: "local",
      folder: "/srv/site",
      command: buildOwnerCodeCommand("/srv/site", "happy-animal-123"),
    })
  })

  test.each([
    ["anonymous:anonymous-agent", "anonymous-agent"],
    ["local:local-ada_team-formula_site", "local"],
    ["local:local-ada-formula", "local"],
    ["  prod:calm-fox-9  ", "calm-fox-9"],
    ["plain-name", "plain-name"],
  ])("strips the kind prefix of %s", (configured, name) => {
    const target = resolveOwnerCodeTarget(
      { NODE_ENV: "development", CONVEX_DEPLOYMENT: configured },
      "/srv/site"
    )
    expect(target.kind === "local" && target.command).toContain(
      `--deployment ${name} &&`
    )
  })

  test.each([
    [undefined],
    [""],
    ["dev:"],
    ["dev:Has Space"],
    ["dev:name; rm -rf ~"],
    ["dev:name$(x)"],
    ["dev:UPPER"],
  ])("shows no command for the deployment %j", (configured) => {
    expect(
      resolveOwnerCodeTarget(
        { NODE_ENV: "development", CONVEX_DEPLOYMENT: configured },
        "/srv/site"
      )
    ).toEqual({ kind: "local-unbound" })
  })

  test("shows no command when the folder is unknown", () => {
    expect(
      resolveOwnerCodeTarget(
        { NODE_ENV: "development", CONVEX_DEPLOYMENT: "dev:ok-1" },
        undefined
      )
    ).toEqual({ kind: "local-unbound" })
  })

  test("live block has no cd and names the deployment", () => {
    expect(buildLiveOwnerCodeCommand("calm-fox-9")).toBe(`(
  FORMULACMS_OWNER_CLAIM_VALUE="$(openssl rand -hex 32)" &&
  printf '%s' "$FORMULACMS_OWNER_CLAIM_VALUE" | npx convex env set FORMULACMS_OWNER_CLAIM --deployment calm-fox-9 &&
  printf '%s\\n' "$FORMULACMS_OWNER_CLAIM_VALUE"
)`)
  })

  test.each([["production"], ["test"], [undefined]])(
    "binds a site that is not in local development (%s) to its Convex Cloud deployment",
    (nodeEnv) => {
      expect(
        resolveOwnerCodeTarget(
          {
            NODE_ENV: nodeEnv,
            CONVEX_DEPLOYMENT: "dev:other-1",
            NEXT_PUBLIC_CONVEX_URL: "https://calm-fox-9.convex.cloud",
          },
          "/srv/site"
        )
      ).toEqual({
        kind: "live",
        deployment: "calm-fox-9",
        command: buildLiveOwnerCodeCommand("calm-fox-9"),
      })
    }
  )

  describe("a production build on this machine's own backend", () => {
    test.each([
      [
        "production",
        "local:local-ada-formula",
        "http://127.0.0.1:3210",
        "local",
      ],
      [
        "production",
        "anonymous:anonymous-agent",
        "http://localhost:3210",
        "anonymous-agent",
      ],
      [
        "test",
        "local:local-ada_team-formula_site",
        "http://[::1]:3210/",
        "local",
      ],
      [
        undefined,
        "  local:local-ada-formula  ",
        "  http://127.0.0.1:3210  ",
        "local",
      ],
    ])(
      "NODE_ENV %j with %j at %j stays local",
      (nodeEnv, configured, url, name) => {
        expect(
          resolveOwnerCodeTarget(
            {
              NODE_ENV: nodeEnv,
              CONVEX_DEPLOYMENT: configured,
              NEXT_PUBLIC_CONVEX_URL: url,
            },
            "/srv/site"
          )
        ).toEqual({
          kind: "local",
          folder: "/srv/site",
          command: buildOwnerCodeCommand("/srv/site", name),
        })
      }
    )

    test("shows no command when the folder is unknown", () => {
      expect(
        resolveOwnerCodeTarget(
          {
            NODE_ENV: "production",
            CONVEX_DEPLOYMENT: "local:local-ada-formula",
            NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
          },
          undefined
        )
      ).toEqual({ kind: "local-unbound" })
    })

    test("follows the Convex Cloud URL the site uses, not a stale local deployment", () => {
      expect(
        resolveOwnerCodeTarget(
          {
            NODE_ENV: "production",
            CONVEX_DEPLOYMENT: "local:local-ada-formula",
            NEXT_PUBLIC_CONVEX_URL: "https://calm-fox-9.convex.cloud",
          },
          "/srv/site"
        )
      ).toEqual({
        kind: "live",
        deployment: "calm-fox-9",
        command: buildLiveOwnerCodeCommand("calm-fox-9"),
      })
    })

    test.each([
      ["dev:calm-fox-9", "http://127.0.0.1:3210"],
      ["prod:calm-fox-9", "http://localhost:3210"],
      [undefined, "http://127.0.0.1:3210"],
      ["local:local-ada-formula", undefined],
      ["local:local-ada-formula", "not a url"],
      ["local:local-ada-formula", "http://10.0.0.22:3210"],
      ["local:local-ada-formula", "http://127.0.0.1.example.com:3210"],
      ["anonymous:anonymous-agent", "https://backend.example.com:3210"],
    ])(
      "is not local with %j at %j, so no command is shown",
      (configured, url) => {
        expect(
          resolveOwnerCodeTarget(
            {
              NODE_ENV: "production",
              CONVEX_DEPLOYMENT: configured,
              NEXT_PUBLIC_CONVEX_URL: url,
            },
            "/srv/site"
          )
        ).toEqual({ kind: "live-unbound" })
      }
    )
  })

  test.each([
    ["https://calm-fox-9.convex.cloud/", "calm-fox-9"],
    ["  https://calm-fox-9.convex.cloud  ", "calm-fox-9"],
    ["https://Calm-Fox-9.convex.cloud", "calm-fox-9"],
  ])("reads the deployment name from %j", (url, name) => {
    expect(convexCloudDeploymentName(url)).toBe(name)
  })

  test.each([
    [undefined],
    [""],
    ["not a url"],
    ["http://calm-fox-9.convex.cloud"],
    ["https://calm-fox-9.convex.site"],
    ["https://convex.example.com"],
    ["https://backend.example.com:3210"],
    ["https://a.b.convex.cloud"],
    ["https://under_score.convex.cloud"],
    ["https://convex.cloud"],
  ])("shows no live command for the URL %j", (url) => {
    expect(
      resolveOwnerCodeTarget(
        { NODE_ENV: "production", NEXT_PUBLIC_CONVEX_URL: url },
        "/srv/site"
      )
    ).toEqual({ kind: "live-unbound" })
  })
})
