// JATA Qi Organizations — types. Multi-tenancy primitives: organizations,
// memberships with hierarchical roles, invitations, and tenant-scoped isolation.

export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';

/** Rank used for role gating (higher = more privileged). */
export const ROLE_RANK: Record<OrgRole, number> = { guest: 1, member: 2, admin: 3, owner: 4 };

export type OrgStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  status: OrgStatus;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface Membership {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  createdAt: number;
}

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface Invitation {
  id: string;
  orgId: string;
  target: string; // username or email
  role: OrgRole;
  status: InvitationStatus;
  token: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

export const OrganizationEvents = Object.freeze({
  OrganizationCreated: 'org.created',
  MemberAdded: 'org.member.added',
  MemberRemoved: 'org.member.removed',
  RoleChanged: 'org.member.role_changed',
  InvitationCreated: 'org.invitation.created',
  InvitationAccepted: 'org.invitation.accepted',
} as const);
