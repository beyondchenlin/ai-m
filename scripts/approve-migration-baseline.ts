import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { approveBaseline, inspectBaselineApproval } from "../src/lib/db/migration-baseline-approval";
import { resolveMigrationsFolder } from "../src/lib/db";

const args = new Map(process.argv.slice(2).map((value, index, all) =>
  value.startsWith("--") ? [value.slice(2), all[index + 1]] : ["", ""]));
const databasePath = args.get("db");
const boundaryCount = Number(args.get("boundary"));
if (!databasePath || !Number.isInteger(boundaryCount)) throw new Error("Use --db <path> --boundary <count> [--approve <token> --backup <path>]");
const sqlite = new Database(databasePath, { fileMustExist: true });
const migrations = readMigrationFiles({ migrationsFolder: resolveMigrationsFolder() });
try {
  const token = args.get("approve");
  if (!token) console.log(JSON.stringify(inspectBaselineApproval(sqlite, databasePath, migrations, boundaryCount), null, 2));
  else {
    const backup = args.get("backup");
    if (!backup) throw new Error("Approval requires --backup <path>");
    await approveBaseline(sqlite, databasePath, migrations, boundaryCount, token, backup);
    console.log("Approved migration baseline after verified backup and identity recheck");
  }
} finally { sqlite.close(); }
