# Publisher endpoint contract

## Lifecycle

Implement every endpoint with:

```text
preflight(article, context)
prepare(article, context)
publish(prepared, confirmation, context)
status(receipt, context)
```

- Keep `preflight`, `prepare`, and `status` read-only with respect to Git worktree and remote services.
- Allow external side effects only in `publish` after confirmation validation.
- Return `unsupported` instead of inventing a remote status.

## Prepared plan

Bind the confirmation token to:

```text
endpoint
articleId
packageRevision
optionsDigest
planDigest
baselineDigest
renderDigest
actions
```

Exclude absolute artifact paths from the token. Reject a token when any bound field changes.

## Receipt

Record:

```text
receiptId
endpoint
articleId
packageRevision
planDigest
idempotencyKey
state
checkpoint
sideEffects
statusLocator
error
```

Never record access tokens or secrets.

## Error outcomes

- Retry automatically only when `retryable=true` and `outcome=not_applied`.
- Resume `partial` from a recorded checkpoint when safe.
- Require remote inspection for `outcome_unknown`.
- Never silently overwrite an already public revision.

## Initial endpoint semantics

### blog-git

One confirmed plan authorizes applying the exact candidate, staging only managed files, committing, and a lease-guarded fast-forward update. Use the confirmed remote SHA as an exact compare-and-swap lease only after proving the new commit directly descends from it; never rewrite history. Save a committed checkpoint if push fails. Treat verified remote-ref success as endpoint success; Vercel deployment is a separate observer.

### wechat-draft-baoyu

Create one private draft from frozen HTML and images. Return `draft_created`, `partial`, or `outcome_unknown`. Do not expose formal publication.
