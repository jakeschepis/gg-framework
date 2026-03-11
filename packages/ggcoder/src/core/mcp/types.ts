export interface MCPServerConfig {
  name: string;
  /** Streamable HTTP endpoint URL */
  url?: string;
  headers?: Record<string, string>;
  /** Stdio server: command to spawn */
  command?: string;
  /** Stdio server: command arguments */
  args?: string[];
  /** Stdio server: environment variables */
  env?: Record<string, string>;
  timeout?: number;
  enabled?: boolean;
}
