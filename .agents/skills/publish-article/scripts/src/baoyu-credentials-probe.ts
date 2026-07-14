import { pathToFileURL } from "node:url";

import { canonicalJson, digestCanonical } from "./canonical-json";
import { asPublishError, PublishError } from "./errors";

interface ResolvedAccountLike {
  name?: string;
  alias?: string;
}

interface LoadedCredentialsLike {
  appId?: string;
  source: string;
  skippedSources?: string[];
}

interface WechatConfigModule {
  loadWechatExtendConfig(): unknown;
  listAccounts(config: unknown): string[];
  resolveAccount(config: unknown, alias?: string): ResolvedAccountLike;
  loadCredentials(account?: ResolvedAccountLike): LoadedCredentialsLike;
}

export interface BaoyuCredentialProbeOptions {
  configModulePath: string;
  account: string;
  allowUnprefixedCredentials?: boolean;
}

export interface BaoyuCredentialProbeResult {
  schemaVersion: 1;
  account: {
    alias: string;
    name?: string;
    availableAliases: string[];
  };
  credentials: {
    source: string;
    skippedSources: string[];
    accountIdentityDigest: string;
  };
}

function isWechatConfigModule(value: unknown): value is WechatConfigModule {
  if (!value || typeof value !== "object") return false;
  const module = value as Record<string, unknown>;
  return ["loadWechatExtendConfig", "listAccounts", "resolveAccount", "loadCredentials"]
    .every((name) => typeof module[name] === "function");
}

function usesUnprefixedCredentials(source: string): boolean {
  return source === "process.env"
    || source === "<cwd>/.baoyu-skills/.env"
    || source === "~/.baoyu-skills/.env";
}

export async function probeBaoyuCredentials(
  options: BaoyuCredentialProbeOptions,
): Promise<BaoyuCredentialProbeResult> {
  if (!options.account.trim()) {
    throw new PublishError("E_ACCOUNT_REQUIRED", "An explicit WeChat account alias is required", {
      kind: "precondition",
    });
  }

  let imported: unknown;
  try {
    imported = await import(pathToFileURL(options.configModulePath).href);
  } catch (error) {
    throw new PublishError("E_CREDENTIAL_PROBE_MODULE", "Cannot load Baoyu credential module", {
      kind: "precondition",
      details: {
        configModulePath: options.configModulePath,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  if (!isWechatConfigModule(imported)) {
    throw new PublishError("E_CREDENTIAL_PROBE_MODULE", "Baoyu credential module has an unsupported API", {
      kind: "precondition",
      details: { configModulePath: options.configModulePath },
    });
  }

  const config = imported.loadWechatExtendConfig();
  const availableAliases = imported.listAccounts(config).filter((alias) => typeof alias === "string" && alias.length > 0);
  if (!availableAliases.includes(options.account)) {
    throw new PublishError("E_ACCOUNT_UNKNOWN", `Unknown WeChat account alias: ${options.account}`, {
      kind: "precondition",
      details: { account: options.account, availableAliases },
    });
  }

  const resolved = imported.resolveAccount(config, options.account);
  if (resolved.alias !== options.account) {
    throw new PublishError("E_ACCOUNT_MISMATCH", "Baoyu resolved a different WeChat account", {
      kind: "precondition",
      details: { requested: options.account, resolved: resolved.alias },
    });
  }

  let loaded: LoadedCredentialsLike;
  try {
    loaded = imported.loadCredentials(resolved);
  } catch (error) {
    throw new PublishError("E_CREDENTIALS_MISSING", error instanceof Error ? error.message : String(error), {
      kind: "auth",
      details: { account: options.account },
    });
  }
  if (!loaded || typeof loaded.source !== "string" || !loaded.source) {
    throw new PublishError("E_CREDENTIAL_PROBE_PROTOCOL", "Baoyu credential loader returned an invalid result", {
      kind: "precondition",
    });
  }
  if (usesUnprefixedCredentials(loaded.source) && !options.allowUnprefixedCredentials) {
    throw new PublishError(
      "E_CREDENTIALS_AMBIGUOUS",
      `Account ${options.account} resolved through unprefixed credentials; use account-prefixed credentials`,
      {
        kind: "precondition",
        details: { account: options.account, source: loaded.source },
      },
    );
  }
  if (typeof loaded.appId !== "string" || !loaded.appId.trim()) {
    throw new PublishError("E_CREDENTIAL_PROBE_PROTOCOL", "Baoyu credential loader did not return an AppID", {
      kind: "precondition",
    });
  }

  return {
    schemaVersion: 1,
    account: {
      alias: options.account,
      name: resolved.name,
      availableAliases,
    },
    credentials: {
      source: loaded.source,
      skippedSources: Array.isArray(loaded.skippedSources) ? loaded.skippedSources : [],
      accountIdentityDigest: digestCanonical({
        scope: "wechat-account-app-id:v1",
        appId: loaded.appId.trim(),
      }),
    },
  };
}

function parseCliArgs(argv: string[]): BaoyuCredentialProbeOptions {
  const values = new Map<string, string>();
  let allowUnprefixedCredentials = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-unprefixed-credentials") {
      allowUnprefixedCredentials = true;
      continue;
    }
    if (arg?.startsWith("--") && argv[index + 1]) {
      values.set(arg, argv[index + 1]!);
      index += 1;
    }
  }
  const configModulePath = values.get("--config-module");
  const account = values.get("--account");
  if (!configModulePath || !account) {
    throw new PublishError(
      "E_USAGE",
      "Usage: baoyu-credentials-probe.ts --config-module <path> --account <alias>",
    );
  }
  return { configModulePath, account, allowUnprefixedCredentials };
}

if (import.meta.main) {
  try {
    const result = await probeBaoyuCredentials(parseCliArgs(process.argv.slice(2)));
    process.stdout.write(canonicalJson(result));
  } catch (error) {
    const publishError = asPublishError(error);
    process.stderr.write(`@@BLOG_WECHAT_ERROR@@ ${canonicalJson(publishError.data)}`);
    process.exitCode = 1;
  }
}
