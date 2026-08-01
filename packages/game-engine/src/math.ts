// NOVA engine math — small, allocation-conscious vector / quaternion / matrix
// library used by transforms, physics, and world generation. Pure functions
// operate on flat tuples (number[]) so hot loops avoid object churn; the Vec
// helpers below provide ergonomic wrappers.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
/** Quaternion as [x, y, z, w]. */
export type Quat = [number, number, number, number];
/** Row-major 4x4 matrix (16 numbers). */
export type Mat4 = number[];

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const vec2 = (x = 0, y = 0): Vec2 => [x, y];

export function v3add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function v3sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function v3scale(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
export function v3dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function v3cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function v3len(a: Vec3): number { return Math.hypot(a[0], a[1], a[2]); }
export function v3dist(a: Vec3, b: Vec3): number { return v3len(v3sub(a, b)); }
export function v3norm(a: Vec3): Vec3 {
  const l = v3len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export function v3lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---- 2D helpers ----------------------------------------------------------

export function v2add(a: Vec2, b: Vec2): Vec2 { return [a[0] + b[0], a[1] + b[1]]; }
export function v2sub(a: Vec2, b: Vec2): Vec2 { return [a[0] - b[0], a[1] - b[1]]; }
export function v2scale(a: Vec2, s: number): Vec2 { return [a[0] * s, a[1] * s]; }
export function v2dot(a: Vec2, b: Vec2): number { return a[0] * b[0] + a[1] * b[1]; }
export function v2len(a: Vec2): number { return Math.hypot(a[0], a[1]); }
export function v2dist(a: Vec2, b: Vec2): number { return v2len(v2sub(a, b)); }
export function v2norm(a: Vec2): Vec2 {
  const l = v2len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0];
}

// ---- Quaternions ---------------------------------------------------------

export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => [x, y, z, w];

/** Quaternion from axis-angle (axis need not be normalized). */
export function quatAxisAngle(axis: Vec3, angle: number): Quat {
  const a = v3norm(axis);
  const h = angle * 0.5;
  const s = Math.sin(h);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
}

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatNormalize(a: Quat): Quat {
  const l = Math.hypot(a[0], a[1], a[2], a[3]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l, a[3] / l] : [0, 0, 0, 1];
}

/** Rotate a vector by a quaternion. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/** SLERP between two quaternions. */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let b2 = b;
  if (dot < 0) { b2 = [-b[0], -b[1], -b[2], -b[3]]; dot = -dot; }
  if (dot > 0.9995) {
    return quatNormalize([
      a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t,
      a[2] + (b2[2] - a[2]) * t, a[3] + (b2[3] - a[3]) * t,
    ]);
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const s0 = Math.sin((1 - t) * theta) / sinTheta;
  const s1 = Math.sin(t * theta) / sinTheta;
  return [
    a[0] * s0 + b2[0] * s1, a[1] * s0 + b2[1] * s1,
    a[2] * s0 + b2[2] * s1, a[3] * s0 + b2[3] * s1,
  ];
}

// ---- Mat4 ----------------------------------------------------------------

export const mat4Identity = (): Mat4 => [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

/** Build a TRS (translation, rotation, scale) model matrix. */
export function mat4TRS(pos: Vec3, rot: Quat, scale: Vec3): Mat4 {
  const { 0: x, 1: y, 2: z, 3: w } = rot;
  const sx = scale[0], sy = scale[1], sz = scale[2];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sy, (xz - wy) * sz, 0,
    (xy - wz) * sx, (1 - (xx + zz)) * sy, (yz + wx) * sz, 0,
    (xz + wy) * sx, (yz - wx) * sy, (1 - (xx + yy)) * sz, 0,
    pos[0], pos[1], pos[2], 1,
  ];
}

export function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[c + 4]! + a[r * 4 + 2]! * b[c + 8]! + a[r * 4 + 3]! * b[c + 12]!;
    }
  }
  return out;
}

/** Clamp a value to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Convert degrees to radians. */
export const toRad = (deg: number): number => (deg * Math.PI) / 180;
/** Convert radians to degrees. */
export const toDeg = (rad: number): number => (rad * 180) / Math.PI;
