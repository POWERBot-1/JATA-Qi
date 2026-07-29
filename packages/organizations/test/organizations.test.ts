import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { OrganizationsModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('OrganizationsModule (kernel integration)', () => {
  let kernel: Kernel;
  let orgs: OrganizationsModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new OrganizationsModule());
    await kernel.boot();
    orgs = kernel.getModule<OrganizationsModule>('organizations');
  });

  it('creates an organization and makes the owner a member', async () => {
    const org = await orgs.createOrganization('Acme', 'owner-1');
    assert.equal(org.slug, 'acme');
    assert.equal(await orgs.isMember(org.id, 'owner-1'), true);
    const owner = await orgs.getMembership(org.id, 'owner-1');
    assert.equal(owner!.role, 'owner');
  });

  it('lists organizations for a user', async () => {
    const o1 = await orgs.createOrganization('Acme', 'u1');
    const o2 = await orgs.createOrganization('Globex', 'u1');
    const mine = await orgs.organizationsForUser('u1');
    assert.equal(mine.length, 2);
  });

  it('adds members, changes roles, and enforces role gating', async () => {
    const org = await orgs.createOrganization('Acme', 'owner-1');
    await orgs.addMember(org.id, 'dev-1', 'member');
    await orgs.setRole(org.id, 'dev-1', 'admin');
    assert.equal((await orgs.getMembership(org.id, 'dev-1'))!.role, 'admin');

    // A member cannot pass an admin requirement.
    await orgs.addMember(org.id, 'intern-1', 'guest');
    await assert.rejects(() => orgs.requireRole(org.id, 'intern-1', 'admin'), /requires admin/);
    // An admin passes the member requirement.
    const ok = await orgs.requireRole(org.id, 'dev-1', 'member');
    assert.equal(ok.role, 'admin');
  });

  it('prevents removing or demoting the owner', async () => {
    const org = await orgs.createOrganization('Acme', 'owner-1');
    await assert.rejects(() => orgs.removeMember(org.id, 'owner-1'), /owner/);
    await assert.rejects(() => orgs.setRole(org.id, 'owner-1', 'member'), /owner/);
  });

  it('removes members and prevents duplicate membership', async () => {
    const org = await orgs.createOrganization('Acme', 'owner-1');
    await orgs.addMember(org.id, 'dev-1');
    await assert.rejects(() => orgs.addMember(org.id, 'dev-1'), /already a member/);
    assert.equal(await orgs.removeMember(org.id, 'dev-1'), true);
    assert.equal(await orgs.isMember(org.id, 'dev-1'), false);
  });

  it('invites, accepts (becomes member) and declines', async () => {
    const org = await orgs.createOrganization('Acme', 'owner-1');
    const inv = await orgs.invite(org.id, 'newperson@example.com', 'member', 'owner-1');
    assert.equal(inv.status, 'pending');
    const membership = await orgs.acceptInvitation(inv.token, 'user-2');
    assert.equal(membership.role, 'member');
    assert.equal(await orgs.isMember(org.id, 'user-2'), true);

    const inv2 = await orgs.invite(org.id, 'someone@example.com', 'member', 'owner-1');
    await orgs.declineInvitation(inv2.token);
    assert.equal((await orgs.declineInvitation(inv2.token)).status, 'declined');
  });

  it('rejects invitations from non-members', async () => {
    const org = await orgs.createOrganization('Acme', 'owner-1');
    await assert.rejects(() => orgs.invite(org.id, 'x@example.com', 'member', 'outsider'), /not a member/);
  });

  it('tenant scoping: only members see org resources via requireRole', async () => {
    const org = await orgs.createOrganization('Acme', 'owner-1');
    await assert.rejects(() => orgs.requireRole(org.id, 'intruder', 'member'), /not a member/);
  });
});
