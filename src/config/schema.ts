import { z } from "zod";

// ── Sub-schemas ─────────────────────────────────────────────────────────────

const DatabaseSchema = z.object({
  url: z.string().default(""),
  poolMin: z.number().int().min(0).default(2),
  poolMax: z.number().int().min(1).default(10),
});

const ApiSchema = z.object({
  port: z.number().int().min(0).max(65535).default(0),
  cors: z.array(z.string()).default(["*"]),
  trustProxy: z.boolean().default(false),
});

const LoggingSchema = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("warn"),
  format: z.enum(["json", "pretty"]).default("pretty"),
});

const FeaturesSchema = z.record(z.string(), z.boolean()).default({});

const BuildSchema = z.object({
  outDir: z.string().default("dist"),
  sourceMaps: z.boolean().default(true),
  minify: z.boolean().default(false),
});

// ── Unified config schema ───────────────────────────────────────────────────

export const ProjectConfigSchema = z.object({
  projectName: z.string().default("runcore"),
  environment: z.enum(["dev", "staging", "prod", "test"]).default("dev"),
  brainDir: z.string().default("./brain"),
  dataDir: z.string().default(".core"),
  encrypt: z.boolean().default(false),
  safeWord: z.string().optional(),
  database: DatabaseSchema.default(() => ({ url: "", poolMin: 2, poolMax: 10 })),
  api: ApiSchema.default(() => ({ port: 0, cors: ["*"], trustProxy: false })),
  logging: LoggingSchema.default(() => ({ level: "warn" as const, format: "pretty" as const })),
  features: FeaturesSchema,
  build: BuildSchema.default(() => ({ outDir: "dist", sourceMaps: true, minify: false })),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function parseConfig(raw: unknown): ProjectConfig {
  return ProjectConfigSchema.parse(raw);
}

export function safeParseConfig(raw: unknown) {
  return ProjectConfigSchema.safeParse(raw);
}

export function configFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
  const raw: Record<string, unknown> = {
    projectName: env.CORE_PROJECT_NAME,
    environment: env.NODE_ENV === "production" ? "prod"
      : env.NODE_ENV === "staging" ? "staging"
      : env.NODE_ENV === "test" ? "test"
      : env.NODE_ENV === "development" ? "dev"
      : env.CORE_ENV,
    brainDir: env.CORE_HOME,
    dataDir: env.CORE_DATA,
    encrypt: env.CORE_ENCRYPT === "true" ? true : undefined,
    safeWord: env.CORE_SAFE_WORD,
    database: {
      url: env.DATABASE_URL,
      poolMin: env.DB_POOL_MIN ? parseInt(env.DB_POOL_MIN, 10) : undefined,
      poolMax: env.DB_POOL_MAX ? parseInt(env.DB_POOL_MAX, 10) : undefined,
    },
    api: {
      port: env.CORE_PORT ? parseInt(env.CORE_PORT, 10) : undefined,
      cors: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(",") : undefined,
      trustProxy: env.TRUST_PROXY === "true" ? true : undefined,
    },
    logging: {
      level: env.LOG_LEVEL,
      format: env.LOG_FORMAT,
    },
    features: env.FEATURE_FLAGS ? JSON.parse(env.FEATURE_FLAGS) : undefined,
    build: {
      outDir: env.BUILD_OUT_DIR,
      sourceMaps: env.BUILD_SOURCE_MAPS === "false" ? false : undefined,
      minify: env.BUILD_MINIFY === "true" ? true : undefined,
    },
  };

  const cleaned = JSON.parse(JSON.stringify(raw));
  const merged = deepMerge(cleaned, overrides as Record<string, unknown>);
  return ProjectConfigSchema.parse(merged);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv !== undefined && sv !== null && typeof sv === "object" && !Array.isArray(sv)) {
      result[key] = deepMerge(
        (result[key] as Record<string, unknown>) ?? {},
        sv as Record<string, unknown>,
      );
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result;
}
