// OrganizationsModule — multi-tenancy. Owns organizations, memberships, roles,
// and invitations; provides membership/role gating and tenant-scoping helpers
// that other modules use to isolate data per organization.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { OrganizationEvents, ROLE_RANK } from './types.js';
import type { Invitation, Membership, Organization, OrgRole } from './types.js';

const COL_ORGS = 'orgs.organizations';
const COL_MEMBERS = 'orgs.memberships';
const COL_INVITES = 'orgs.invitations';
const INVITE_TTL = 7 * 86_400_000;

export class OrganizationsModule implements IModule {
  readonly id = 'organizations';
  readonly tags = ['core', 'identity'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private orgs!: ICollection<Organization>;
  private members!: ICollection<Membership>;
  private invites!: ICollection<Invitation>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.orgs = await C<Organization>(COL_ORGS);
    this.members = await C<Membership>(COL_MEMBERS);
    this.invites = await C<Invitation>(COL_INVITES);
    kernel.container.registerValue('organizations', this);
    kernel.logger.info('organizations module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // --- organizations -------------------------------------------------------

  async createOrganization(name: string, ownerId: string, slug?: string): Promise<Organization> {
    if (!name || !ownerId) throw new Error('organizations: name and ownerId are required');
    const org: Organization = {
      id: randomUUID(),
      name,
      slug: slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      ownerId,
      status: 'ACTIVE',
      createdAt: Date.now(),
    };
    await this.orgs.put(org);
    // Owner is implicitly a member with the owner role.
    await this.addMember(org.id, ownerId, 'owner');
    await this.api.bus.emit(OrganizationEvents.OrganizationCreated, { orgId: org.id, ownerId });
    return org;
  }

  async getOrganization(id: string): Promise<Organization | undefined> {
    return this.orgs.get(id);
  }
  async listOrganizations(): Promise<Organization[]> { return this.orgs.all(); }
  /** Organizations a user belongs to. */
  async organizationsForUser(userId: string): Promise<Organization[]> {
    const mine = (await this.members.all()).filter((m) => m.userId === userId);
    const ids = new Set(mine.map((m) => m.orgId));
    return (await this.orgs.all()).filter((o) => ids.has(o.id));
  }

  // --- memberships ---------------------------------------------------------

  async addMember(orgId: string, userId: string, role: OrgRole = 'member'): Promise<Membership> {
    const existing = await this.getMembership(orgId, userId);
    if (existing) throw new Error(`organizations: user "${userId}" is already a member of "${orgId}"`);
    const membership: Membership = { id: `${orgId}:${userId}`, orgId, userId, role, createdAt: Date.now() };
    await this.members.put(membership);
    await this.api.bus.emit(OrganizationEvents.MemberAdded, { orgId, userId, role });
    return membership;
  }

  async removeMember(orgId: string, userId: string): Promise<boolean> {
    const m = await this.getMembership(orgId, userId);
    if (!m) return false;
    if (m.role === 'owner') throw new Error('organizations: cannot remove the owner; transfer ownership first');
    // Membership id is deterministic: orgId:userId.
    await this.members.delete(`${orgId}:${userId}`);
    await this.api.bus.emit(OrganizationEvents.MemberRemoved, { orgId, userId });
    return true;
  }

  async listMembers(orgId: string): Promise<Membership[]> {
    return (await this.members.all()).filter((m) => m.orgId === orgId);
  }

  async getMembership(orgId: string, userId: string): Promise<Membership | undefined> {
    const all = await this.members.all();
    return all.find((m) => m.orgId === orgId && m.userId === userId);
  }

  async setRole(orgId: string, userId: string, role: OrgRole): Promise<Membership> {
    const m = await this.getMembership(orgId, userId);
    if (!m) throw new Error(`organizations: user "${userId}" is not a member of "${orgId}"`);
    if (m.role === 'owner' && role !== 'owner') throw new Error('organizations: demote the owner via ownership transfer first');
    const updated: Membership = { ...m, role };
    await this.members.put(updated);
    await this.api.bus.emit(OrganizationEvents.RoleChanged, { orgId, userId, role });
    return updated;
  }

  /** True if the user is a member of the org. */
  async isMember(orgId: string, userId: string): Promise<boolean> {
    return (await this.getMembership(orgId, userId)) !== undefined;
  }

  /** Throw unless the user is a member with at least `minRole`. */
  async requireRole(orgId: string, userId: string, minRole: OrgRole): Promise<Membership> {
    const m = await this.getMembership(orgId, userId);
    if (!m) throw new Error(`organizations: user "${userId}" is not a member of "${orgId}"`);
    if (ROLE_RANK[m.role] < ROLE_RANK[minRole]) {
      throw new Error(`organizations: requires ${minRole} role (user is ${m.role})`);
    }
    return m;
  }

  // --- invitations ---------------------------------------------------------

  async invite(orgId: string, target: string, role: OrgRole, invitedBy: string): Promise<Invitation> {
    const inviter = await this.getMembership(orgId, invitedBy);
    if (!inviter) throw new Error('organizations: inviter is not a member');
    const invitation: Invitation = {
      id: randomUUID(), orgId, target, role, status: 'pending',
      token: randomUUID(), invitedBy, createdAt: Date.now(), expiresAt: Date.now() + INVITE_TTL,
    };
    await this.invites.put(invitation);
    await this.api.bus.emit(OrganizationEvents.InvitationCreated, { orgId, target });
    return invitation;
  }

  async acceptInvitation(token: string, userId: string): Promise<Membership> {
    const inv = (await this.invites.all()).find((i) => i.token === token);
    if (!inv) throw new Error('organizations: invitation not found');
    if (inv.status !== 'pending') throw new Error(`organizations: invitation already ${inv.status}`);
    if (inv.expiresAt < Date.now()) {
      inv.status = 'expired';
      await this.invites.put(inv);
      throw new Error('organizations: invitation expired');
    }
    inv.status = 'accepted';
    await this.invites.put(inv);
    const membership = await this.addMember(inv.orgId, userId, inv.role);
    await this.api.bus.emit(OrganizationEvents.InvitationAccepted, { orgId: inv.orgId, userId });
    return membership;
  }

  async declineInvitation(token: string): Promise<Invitation> {
    const inv = (await this.invites.all()).find((i) => i.token === token);
    if (!inv) throw new Error('organizations: invitation not found');
    inv.status = 'declined';
    await this.invites.put(inv);
    return inv;
  }
}
