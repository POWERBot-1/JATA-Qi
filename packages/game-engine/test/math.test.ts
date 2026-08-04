// Math library tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  v3add, v3sub, v3scale, v3dot, v3cross, v3len, v3norm, v3lerp,
  quatAxisAngle, quatMul, quatNormalize, quatRotate, quatSlerp,
  mat4TRS, mat4Mul, mat4Identity, clamp, lerp, toRad,
} from '../src/index.js';

describe('math — vectors', () => {
  it('add/sub/scale/dot/cross', () => {
    assert.deepEqual(v3add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
    assert.deepEqual(v3sub([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
    assert.deepEqual(v3scale([1, 2, 3], 2), [2, 4, 6]);
    assert.equal(v3dot([1, 2, 3], [4, 5, 6]), 32);
    assert.deepEqual(v3cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  });

  it('length/normalize/lerp', () => {
    assert.equal(v3len([3, 4, 0]), 5);
    const n = v3norm([0, 0, 5]);
    assert.deepEqual(n, [0, 0, 1]);
    assert.deepEqual(v3lerp([0, 0, 0], [10, 0, 0], 0.5), [5, 0, 0]);
  });
});

describe('math — quaternions', () => {
  it('axis-angle rotates a vector 90° around Z', () => {
    const q = quatAxisAngle([0, 0, 1], Math.PI / 2);
    const r = quatRotate(q, [1, 0, 0]);
    assert.ok(Math.abs(r[0] - 0) < 1e-9);
    assert.ok(Math.abs(r[1] - 1) < 1e-9);
  });

  it('multiplying two 90° rotations yields 180°', () => {
    const q90 = quatAxisAngle([0, 1, 0], Math.PI / 2);
    const q180 = quatNormalize(quatMul(q90, q90));
    const r = quatRotate(q180, [1, 0, 0]);
    assert.ok(Math.abs(r[0] + 1) < 1e-9); // flipped to -X
  });

  it('slerp interpolates halfway', () => {
    const a = quatAxisAngle([0, 1, 0], 0);
    const b = quatAxisAngle([0, 1, 0], Math.PI);
    const mid = quatSlerp(a, b, 0.5);
    const r = quatRotate(mid, [1, 0, 0]);
    assert.ok(Math.abs(r[1]) < 1e-9); // 90° around Y -> Z axis
    assert.ok(Math.abs(Math.abs(r[2]) - 1) < 1e-9);
  });
});

describe('math — matrices', () => {
  it('TRS translation lands in the position column', () => {
    const m = mat4TRS([1, 2, 3], [0, 0, 0, 1], [1, 1, 1]);
    assert.equal(m[12], 1);
    assert.equal(m[13], 2);
    assert.equal(m[14], 3);
  });

  it('identity * identity = identity', () => {
    const i = mat4Identity();
    const r = mat4Mul(i, i);
    assert.deepEqual(r, i);
  });

  it('scale is applied to the basis', () => {
    const m = mat4TRS([0, 0, 0], [0, 0, 0, 1], [2, 3, 4]);
    // basis vectors are columns 0..3 of rows; check scale on diagonal-ish.
    assert.ok(Math.abs(m[0] - 2) < 1e-9);
    assert.ok(Math.abs(m[5] - 3) < 1e-9);
    assert.ok(Math.abs(m[10] - 4) < 1e-9);
  });
});

describe('math — scalar helpers', () => {
  it('clamp/lerp/toRad', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
    assert.equal(lerp(0, 10, 0.3), 3);
    assert.ok(Math.abs(toRad(180) - Math.PI) < 1e-9);
  });
});
