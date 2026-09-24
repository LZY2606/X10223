declare module "node:sqlite" {
  export const SQLITE_OK: number;
  export class StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    finalize(): void;
  }
  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
  }
  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    open(): void;
    close(): void;
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    applyChangeset?(changeset: Uint8Array): void;
  }
}
