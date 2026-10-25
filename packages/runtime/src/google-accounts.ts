/** Verified Google SSO identities. CLI account labels and browser cookies never enter this registry. */
export interface GoogleAccount {
  id: string;
  ownerUserId: string;
  googleSub: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Only call after provider verification of the ID token. */
export interface VerifiedGoogleIdentity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}
