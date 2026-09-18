import { type CloneResult, type FreestyleVolumes } from 'freestyle-volumes';

/**
 * Application-coordinated clone of an existing volume.
 * quiesceSource must stop all application/external writers and prevent new
 * writers or attachments until this function completes. Keep that admission
 * control in your application: advisory attachment records are not a lock.
 */
export async function cloneQuiescedVolume(
  volumes: FreestyleVolumes,
  sourceVolumeId: string,
  name: string,
  quiesceSource: () => Promise<void>,
): Promise<CloneResult> {
  await quiesceSource();

  // A stopped application may still have buffered writes. Drain every known
  // mount using normal detach; never force detach and assume data is durable.
  for (const attachment of await volumes.registry.listAttachments(sourceVolumeId)) {
    const detached = await volumes.detach({
      sandboxId: attachment.sandboxId,
      mountPath: attachment.mountPath,
    });
    if (!detached.flushed) {
      throw new Error('Source durability is unproven; reconcile its retained cache and attachment before cloning.');
    }
  }

  // Server-side, object-wise consistent copy, NOT a point-in-time snapshot.
  // Missing/stale attachment records do not prove that external writers stopped.
  // Above the configured single-copy threshold (default 5 GiB), multipart copy
  // supports objects up to a conservative 5 TiB; parts are sequential per object.
  const result = await volumes.clone({
    sourceVolumeId,
    name,
    allowLiveSource: false,
    concurrency: 8,
    maxObjects: 100_000,              // optional; also the hard cap
    maxManifestBytes: 32 * 1024 ** 2, // optional; UTF-8 JSON metadata budget/cap
    labels: { purpose: 'quiesced-copy' },
  });
  console.log('Clone published:', result.volume.id, 'operation:', result.operationId);
  // If publication is 'unknown' or details.completionUnknown is true, retain the
  // operation data and reconcile the generation/uploads; do not blindly retry.
  // Inspect multipartFailures/abortStatus: even acknowledged abort is not proof
  // of destination absence. Use a bucket lifecycle rule for incomplete uploads.
  // details.cleanupStatus === 'uncertain' means failed remote copies may still
  // finish after the error returns. Retained intents and an empty current listing
  // are not permission for age-based garbage collection.
  return result;
}
