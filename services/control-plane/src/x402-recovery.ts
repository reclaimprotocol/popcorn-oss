export async function recoverInterruptedExtension(actions: {
  rollbackRegional(): Promise<boolean>;
  rollbackMetadata(): Promise<boolean>;
  rollbackAccess(): Promise<boolean>;
}): Promise<boolean> {
  const [regional, metadata, access] = await Promise.all([
    actions.rollbackRegional().catch(() => false),
    actions.rollbackMetadata().catch(() => false),
    actions.rollbackAccess().catch(() => false),
  ]);
  return regional && metadata && access;
}

export async function runCleanupAttempt(actions: {
  deleteRegional(): Promise<boolean>;
  endLocal(): Promise<boolean>;
}): Promise<boolean> {
  const regional = await actions.deleteRegional().catch(() => false);
  if (!regional) return false;
  return await actions.endLocal().catch(() => false);
}
