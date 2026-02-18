import Database from "better-sqlite3";
import { config } from "../config";

export abstract class BaseStore {
  protected db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initTables();
  }

  protected abstract initTables(): void;

  close() {
    this.db.close();
  }
}

export abstract class SettingsStore extends BaseStore {
  // Stored via initSettings() during initTables() — not declared as a class field
  // to avoid ES2022 useDefineForClassFields overwriting the value after super().
  private get _settingsTable(): string {
    return (this as any).__settingsTable;
  }

  protected initSettings(tableName: string): void {
    (this as any).__settingsTable = tableName;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM ${this._settingsTable} WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare(`INSERT OR REPLACE INTO ${this._settingsTable} (key, value) VALUES (?, ?)`).run(key, value);
  }
}
