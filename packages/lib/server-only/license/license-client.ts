import fs from 'node:fs/promises';
import path from 'node:path';

import type { TLicenseClaim } from '../../types/license';
import {
  LICENSE_FILE_NAME,
  type TCachedLicense,
  type TLicenseResponse,
  ZCachedLicenseSchema,
} from '../../types/license';
import { env } from '../../utils/env';

const LICENSE_KEY = env('NEXT_PRIVATE_DOCUMENSO_LICENSE_KEY');
const _LICENSE_SERVER_URL =
  env('INTERNAL_OVERRIDE_LICENSE_SERVER_URL') || 'https://license.documenso.com';

declare global {
  // eslint-disable-next-line no-var
  var __documenso_license_client__: LicenseClient | undefined;
}

export class LicenseClient {
  /**
   * We cache the license in memory incase there is permission issues with
   * retrieving the license from the local file system.
   */
  private cachedLicense: TCachedLicense | null = null;

  private constructor() {}

  /**
   * Start the license client.
   *
   * This will ping the license server with the configured license key and store
   * the response locally in a JSON file.
   *
   * Uses globalThis to store the singleton instance so that it's shared across
   * different bundles (e.g. Hono and Remix) at runtime.
   */
  public static async start(): Promise<void> {
    if (globalThis.__documenso_license_client__) {
      return;
    }

    const instance = new LicenseClient();

    globalThis.__documenso_license_client__ = instance;

    try {
      await instance.initialize();
    } catch (err) {
      // Do nothing.
      console.error('[License] Failed to verify license:', err);
    }
  }

  /**
   * Get the current license client instance.
   *
   * Returns the shared instance from globalThis, ensuring both Hono and Remix
   * bundles access the same instance.
   */
  public static getInstance(): LicenseClient | null {
    return globalThis.__documenso_license_client__ ?? null;
  }

  public async getCachedLicense(): Promise<TCachedLicense | null> {
    if (this.cachedLicense) {
      return this.cachedLicense;
    }

    const localLicenseFile = await this.loadFromFile();

    return localLicenseFile;
  }

  /**
   * Force resync the license from the license server.
   *
   * This will re-ping the license server and update the cached license file.
   */
  public async resync(): Promise<void> {
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    console.log('[License] Checking license with server...');

    const cachedLicense = await this.loadFromFile();

    if (cachedLicense) {
      this.cachedLicense = cachedLicense;
    }

    let response: TLicenseResponse | null = null;

    try {
      response = await this.pingLicenseServer();
    } catch (err) {
      // If server is not responding, or erroring, use the cached license.
      console.warn('[License] License server not responding, using cached license.');
      console.error(err);
      return;
    }

    const allowedFlags = response?.data?.flags || {};

    // Check for unauthorized flag usage
    const unauthorizedFlagUsage = await this.checkUnauthorizedFlagUsage(allowedFlags);

    if (unauthorizedFlagUsage) {
      console.warn('[License] Found unauthorized flag usage.');
    }

    let status: TCachedLicense['derivedStatus'] = 'NOT_FOUND';

    if (response?.data?.status) {
      status = response.data.status;
    }

    if (unauthorizedFlagUsage) {
      status = 'UNAUTHORIZED';
    }

    const data: TCachedLicense = {
      lastChecked: new Date().toISOString(),
      license: response?.data || null,
      requestedLicenseKey: LICENSE_KEY,
      unauthorizedFlagUsage,
      derivedStatus: status,
    };

    this.cachedLicense = data;
    await this.saveToFile(data);

    console.log('[License] License check completed successfully.');
    console.log(`[License] Unauthorized Flag Usage: ${unauthorizedFlagUsage ? 'Yes' : 'No'}`);
    console.log(`[License] Derived Status: ${status}`);
    console.log(`[License] Status: ${response?.data?.status}`);
    console.log(`[License] Flags: ${JSON.stringify(allowedFlags)}`);
  }

  /**
   * Ping the license server to get the license response.
   * MODIFIED: Return mock response to bypass server calls for local development
   * If license not found returns null.
   */
  private async pingLicenseServer(): Promise<TLicenseResponse | null> {
    // BYPASS: Return mock response for local development
    if (!LICENSE_KEY) {
      return null;
    }

    console.log('[License] Bypassing license server call - returning mock response');

    return Promise.resolve({
      success: true,
      data: {
        status: 'ACTIVE',
        createdAt: new Date('2024-01-01'),
        name: 'Enterprise License (Local)',
        periodEnd: new Date('2030-12-31'),
        cancelAtPeriodEnd: false,
        licenseKey: LICENSE_KEY,
        flags: {
          // Enable ALL features
          emailDomains: true,
          embedAuthoring: true,
          embedAuthoringWhiteLabel: true,
          cfr21: true,
          authenticationPortal: true,
          billing: true,
        },
      },
    });

    // Original code commented out for backup
    /*
    const endpoint = new URL('api/license', LICENSE_SERVER_URL).toString();

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ license: LICENSE_KEY }),
    });

    if (!response.ok) {
      throw new Error(`License server returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    return ZLicenseResponseSchema.parse(data);
    */
  }

  private async saveToFile(data: TCachedLicense): Promise<void> {
    const licenseFilePath = path.join(process.cwd(), LICENSE_FILE_NAME);

    try {
      await fs.writeFile(licenseFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error('[License] Failed to save license file:', error);
    }
  }

  private async loadFromFile(): Promise<TCachedLicense | null> {
    const licenseFilePath = path.join(process.cwd(), LICENSE_FILE_NAME);

    try {
      const fileContents = await fs.readFile(licenseFilePath, 'utf-8');

      return ZCachedLicenseSchema.parse(JSON.parse(fileContents));
    } catch {
      return null;
    }
  }

  /**
   * Check if any organisation claims are using flags that are not permitted by the current license.
   * MODIFIED: Always return false to bypass license validation for local development
   */
  private async checkUnauthorizedFlagUsage(
    _licenseFlags: Partial<TLicenseClaim>,
  ): Promise<boolean> {
    // BYPASS: Always return false for local development
    // This prevents unauthorized flag usage detection
    console.log('[License] Bypassing unauthorized flag check - returning false');
    return Promise.resolve(false);

    // Original code commented out for backup
    /*
    // Get flags that are NOT permitted by the license by subtracting the allowed flags from the license flags.
    const disallowedFlags = Object.values(SUBSCRIPTION_CLAIM_FEATURE_FLAGS).filter(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      (flag) => flag.isEnterprise && !licenseFlags[flag.key as keyof TLicenseClaim],
    );

    let unauthorizedFlagUsage = false;

    if (IS_BILLING_ENABLED() && !licenseFlags.billing) {
      unauthorizedFlagUsage = true;
    }

    try {
      const organisationWithUnauthorizedFlags = await prisma.organisationClaim.findFirst({
        where: {
          OR: disallowedFlags.map((flag) => ({
            flags: {
              path: [flag.key],
              equals: true,
            },
          })),
        },
        select: {
          id: true,
          organisation: {
            select: {
              id: true,
            },
          },
          flags: true,
        },
      });

      if (organisationWithUnauthorizedFlags) {
        unauthorizedFlagUsage = true;
      }
    } catch (error) {
      console.error('[License] Failed to check unauthorized flag usage:', error);
    }

    return unauthorizedFlagUsage;
    */
  }
}
