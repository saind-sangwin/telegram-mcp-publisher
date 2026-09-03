import { createPostgresSaasStoreFromEnv } from "./postgres-store.js";

const store = createPostgresSaasStoreFromEnv();
try {
  const recovery = await store.recoverStalePublicationAttempts({
    staleAfterSeconds: Number(process.env.PUBLICATION_ATTEMPT_STALE_SECONDS ?? 300),
  });
  const result = await store.cleanupRetention({
    previewRetentionDays: Number(process.env.PREVIEW_RETENTION_DAYS ?? 7),
    auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS ?? 90),
  });
  console.log(JSON.stringify({ ...recovery, ...result }));
} finally {
  await store.close();
}
