// Directory Adapter Fabric (JQ-DIRECTORY-ADAPTER-FABRIC) and Directory Synchronization (JQ-DIRECTORY-SYNC)

export interface DirectoryListing {
  directoryName: string;
  expectedName: string;
  foundName: string;
  status: 'VERIFIED' | 'NAME_VARIATION' | 'STALE' | 'IMPERSONATION' | 'MISSING';
  lastSynced: string;
}

export interface DirectoryAdapter {
  directoryName: string;
  discover(): Promise<boolean>;
  inspectRequirements(): { rateLimitPerMinute: number; requiresAuth: boolean };
  validateIdentity(canonicalId: string): boolean;
  prepareSubmission(identityPayload: unknown): Record<string, unknown>;
  submit(packageData: Record<string, unknown>, governanceLevel: number): { success: boolean; message: string };
}

export class DirectoryAdapterFabric {
  private readonly adapters = new Map<string, DirectoryAdapter>();

  registerAdapter(adapter: DirectoryAdapter): void {
    this.adapters.set(adapter.directoryName, adapter);
  }

  getAdapter(name: string): DirectoryAdapter | undefined {
    return this.adapters.get(name);
  }

  generateDriftReport(directoryName: string, expected: string, found: string): DirectoryListing {
    let status: DirectoryListing['status'] = 'VERIFIED';
    if (expected !== found) {
      status = 'NAME_VARIATION';
    }
    return {
      directoryName,
      expectedName: expected,
      foundName: found,
      status,
      lastSynced: new Date().toISOString(),
    };
  }
}
