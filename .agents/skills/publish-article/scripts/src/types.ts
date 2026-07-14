export type AssetRole = "cover" | "inline" | "screenshot" | "source";

export interface ArticleAsset {
  id: string;
  path: string;
  sha256: string;
  mediaType: string;
  bytes: number;
  role: AssetRole;
  alt?: string;
  caption?: string;
}

export interface ArticleMetadata {
  title: string;
  slug: string;
  summary: string;
  author: string;
  language: string;
  tags: string[];
  categories: string[];
  publishedAt?: string;
  updatedAt?: string;
  coverAssetId?: string;
}

export interface ArticlePackage {
  schemaVersion: 1;
  articleId: string;
  revision: string;
  metadata: ArticleMetadata;
  body: {
    path: "body.md";
    sha256: string;
  };
  assets: ArticleAsset[];
  provenance: {
    sourceId: string;
    sourceDigest: string;
    packagerVersion: 1;
  };
}

export interface ImportedAsset extends ArticleAsset {
  originalReference: string;
  sourcePath: string;
}

export interface ImportedArticle {
  schemaVersion: 1;
  sourcePath: string;
  sourceDigest: string;
  sourceId: string;
  frontmatter: Record<string, unknown>;
  body: string;
  assets: ImportedAsset[];
}

export interface PublishAction {
  id: string;
  description: string;
  sideEffect: boolean;
}

export interface PreparedPublication {
  schemaVersion: 1;
  endpoint: string;
  articleId: string;
  packageRevision: string;
  optionsDigest: string;
  planDigest: string;
  artifactRoot: string;
  actions: PublishAction[];
  baselineDigest?: string;
  renderDigest?: string;
  previewPath?: string;
}

export type ReceiptState =
  | "prepared"
  | "committed"
  | "pushed"
  | "draft_created"
  | "partial"
  | "failed"
  | "outcome_unknown";

export interface PublishReceipt {
  schemaVersion: 1;
  receiptId: string;
  endpoint: string;
  articleId: string;
  packageRevision: string;
  planDigest: string;
  idempotencyKey: string;
  state: ReceiptState;
  checkpoint?: string;
  sideEffects: Array<Record<string, unknown>>;
  statusLocator?: Record<string, unknown>;
  error?: PublishErrorData;
}

export type PublishErrorKind =
  | "validation"
  | "precondition"
  | "conflict"
  | "auth"
  | "rate_limit"
  | "transient"
  | "provider_rejected"
  | "outcome_unknown";

export type PublishOutcome = "not_applied" | "applied" | "partial" | "unknown";

export interface PublishErrorData {
  code: string;
  kind: PublishErrorKind;
  message: string;
  retryable: boolean;
  outcome: PublishOutcome;
  details?: Record<string, unknown>;
}

export interface EndpointCapabilities {
  draft: boolean;
  publish: boolean;
  update: boolean;
  imageUpload: boolean;
  status: boolean;
}

export interface EndpointContext {
  repoRoot: string;
  runRoot: string;
  options: Record<string, unknown>;
}

export interface PublisherEndpoint {
  id: string;
  capabilities: EndpointCapabilities;
  preflight(article: ArticlePackage, context: EndpointContext): Promise<Record<string, unknown>>;
  prepare(article: ArticlePackage, context: EndpointContext): Promise<PreparedPublication>;
  publish(prepared: PreparedPublication, confirmation: string, context: EndpointContext): Promise<PublishReceipt>;
  status(receipt: PublishReceipt, context: EndpointContext): Promise<Record<string, unknown>>;
}
