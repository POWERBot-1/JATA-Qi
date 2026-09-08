// P1 two-process qualification worker: a SEPARATE OS process that boots the
// FULL production-posture composition (createJataQiFromEnv with
// JATAQI_SECURITY_POSTURE=production) against the same PostgreSQL security
// state, then attempts to authenticate a given token through the production
// boundary. No process-local security state is shared with the parent —
// every verdict below comes from the durable store. Prints one JSON line.

const [token] = process.argv.slice(2);

class WorkerExternalMaterialProvider {
  id = 'p1-worker-external-material-provider';
  kind = 'external';
  keyId = 'p1-worker-key/v1';
  materials = new Map();
  async createMaterial(credentialId) {
    const existing = this.materials.get(credentialId);
    if (existing !== undefined) return existing;
    const material = `p1-worker-material-${credentialId}`;
    this.materials.set(credentialId, material);
    return material;
  }
  async getMaterial(credentialId) {
    const material = this.materials.get(credentialId);
    if (material === undefined) throw new Error('CREDENTIAL_MISSING (fail-closed)');
    return material;
  }
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

if (!token) {
  emit({ ok: false, workerError: 'usage: p1-worker.mjs <token>' });
} else {
  try {
    const { createJataQiFromEnv } = await import('../src/bootstrap.js');
    const instance = await createJataQiFromEnv({
      authorization: {
        durableSecurity: { enabled: true, materialProvider: new WorkerExternalMaterialProvider() },
      },
    });
    try {
      const auth = instance.kernel.getModule('authentication');
      const boundary = auth.getService();
      try {
        const principal = await boundary.authenticate({ method: 'STATIC_TOKEN', material: token });
        emit({ ok: true, authenticated: true, principalId: principal.id, tenantId: principal.tenantId });
      } catch (authError) {
        // The composition BOOTED and the production boundary REJECTED the
        // credential — that is a verdict, not a boot failure.
        emit({ ok: true, authenticated: false, bootFailed: false, error: String(authError.message).slice(0, 300) });
      }
    } finally {
      await instance.shutdown().catch(() => undefined);
    }
  } catch (error) {
    emit({
      ok: true,
      authenticated: false,
      bootFailed: true,
      error: String(error instanceof Error ? error.message : error).slice(0, 300),
    });
  }
}
