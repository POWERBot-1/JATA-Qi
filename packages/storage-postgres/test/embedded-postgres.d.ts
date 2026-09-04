// Minimal ambient declaration for the `embedded-postgres` dev dependency used
// to run a real PostgreSQL instance for integration tests. Matches the subset
// of the upstream API used here.
declare module 'embedded-postgres' {
  export interface EmbeddedPostgresOptions {
    databaseDir: string;
    port: number;
    user: string;
    password: string;
    authMethod: 'scram-sha-256' | 'password' | 'md5';
    persistent: boolean;
    initdbFlags: string[];
    postgresFlags: string[];
    createPostgresUser: boolean;
    onLog: (message: string) => void;
    onError: (messageOrError: string | Error | unknown) => void;
  }
  interface Client {
    query(text: string): Promise<{ rows: unknown[] }>;
    end(): Promise<void>;
  }
  export default class EmbeddedPostgres {
    constructor(options?: Partial<EmbeddedPostgresOptions>);
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
    dropDatabase(name: string): Promise<void>;
    getPgClient(database?: string, host?: string): Client;
  }
}
