import requiredMigrationsManifest from "./required-migrations.json" with { type: "json" };

const MIGRATION_FILENAME = /^\d{3}_[a-z0-9_]+\.sql$/u;

function parseRequiredMigrations(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The required migrations manifest must be an object.");
  }
  const manifest = value as { schemaVersion?: unknown; requiredMigrations?: unknown };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.requiredMigrations)) {
    throw new Error("The required migrations manifest must use schemaVersion 1 and a migration array.");
  }
  const migrations = manifest.requiredMigrations;
  if (
    migrations.length === 0 ||
    migrations.some((migration) => typeof migration !== "string" || !MIGRATION_FILENAME.test(migration))
  ) {
    throw new Error("The required migrations manifest contains an invalid migration filename.");
  }
  if (new Set(migrations).size !== migrations.length) {
    throw new Error("The required migrations manifest contains duplicate migrations.");
  }
  const sorted = [...migrations].sort((left, right) => left.localeCompare(right, "en"));
  if (migrations.some((migration, index) => migration !== sorted[index])) {
    throw new Error("The required migrations manifest must be ordered by migration filename.");
  }
  return Object.freeze([...migrations]);
}

export const REQUIRED_MIGRATIONS = parseRequiredMigrations(requiredMigrationsManifest);

const requiredMigrationHead = REQUIRED_MIGRATIONS.at(-1);
if (!requiredMigrationHead) throw new Error("The required migrations manifest cannot be empty.");
export const REQUIRED_MIGRATION_HEAD = requiredMigrationHead;

export function missingRequiredMigrations(availableMigrations: Iterable<string>): string[] {
  const available = new Set(availableMigrations);
  return REQUIRED_MIGRATIONS.filter((migration) => !available.has(migration));
}

export function assertRequiredMigrationsPresent(availableMigrations: Iterable<string>): void {
  const missing = missingRequiredMigrations(availableMigrations);
  if (missing.length > 0) {
    throw new Error(`Required migrations are missing: ${missing.join(", ")}`);
  }
}
