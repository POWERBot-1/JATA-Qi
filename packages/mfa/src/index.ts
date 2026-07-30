// Public API for @jataqi/mfa.
export { MFAModule } from './mfa-module.js';
export { MFAEvents } from './mfa-module.js';
export type { MFAEnrollment, TrustedDevice } from './mfa-module.js';
// Crypto utilities (for testing / integration).
export {
  generateSecret, computeTOTP, verifyTOTP, generateBackupCodes,
  hashBackupCode, base32Encode, base32Decode,
} from './crypto.js';
