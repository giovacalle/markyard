import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

// `ALCHEMY_LOCAL_STATE=1` keeps state in `.alchemy/` for local-only `alchemy dev` runs (no Cloudflare state writes).
const state = process.env.ALCHEMY_LOCAL_STATE ? Alchemy.localState() : Cloudflare.state();

export default Alchemy.Stack(
  "Markyard",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    // `ENABLE_STATE_DB=1` (or `true`) provisions the optional D1 database behind `/api/state`;
    // without it the Worker has no `STATE_DB` binding and cloud sync stays off.
    const enableStateDbRaw = yield* Config.String("ENABLE_STATE_DB").pipe(Config.withDefault(""));
    const enableStateDb =
      enableStateDbRaw.trim() === "1" || enableStateDbRaw.trim().toLowerCase() === "true";
    const stateDb = enableStateDb
      ? yield* Cloudflare.D1.Database("StateDb", { migrations: "./bff/migrations" })
      : undefined;
    // Custom domain is attached on `prod` deploys from `CUSTOM_DOMAIN` (read from `.env` or shell).
    const customDomainRaw = yield* Config.String("CUSTOM_DOMAIN").pipe(Config.withDefault(""));
    const customDomain = customDomainRaw.trim() || undefined;
    const bff = yield* Cloudflare.Worker("Bff", {
      // The Worker entry imports neither `alchemy` nor `@alchemy.run/cloudflare` (ADR 0003).
      main: "./bff/src/worker.ts",
      bundle: true,
      compatibility: { date: "2026-11-01" },
      domain: stage === "prod" ? customDomain : undefined,
      assets: {
        directory: "./web/dist",
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*"],
      },
      env: {
        PUBLIC_ORIGIN: Config.String("PUBLIC_ORIGIN"),
        ALLOWED_EMAILS: Config.String("ALLOWED_EMAILS"),
        GOOGLE_CLIENT_ID: Config.Redacted("GOOGLE_CLIENT_ID"),
        GOOGLE_CLIENT_SECRET: Config.Redacted("GOOGLE_CLIENT_SECRET"),
        COOKIE_KEYS: Config.Redacted("COOKIE_KEYS"),
        ...(stateDb ? { STATE_DB: stateDb } : {}),
      },
      dev: { port: Number(process.env.BFF_DEV_PORT ?? 8787) },
    });
    return { bff: bff.urls };
  }),
);
