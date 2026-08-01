// GPU detection — probes for CUDA GPUs via nvidia-smi (if available).
// Zero deps; gracefully degrades to CPU-only on systems without GPUs.

import { execSync } from 'node:child_process';
import type { GPUDetection } from './types.js';

let cached: GPUDetection | undefined;

/** Detect GPU availability (cached after first call). */
export function detectGPU(): GPUDetection {
  if (cached) return cached;
  cached = probeGPU();
  return cached;
}

/** Force re-detection (for testing or hotplug). */
export function resetGPUDetection(): void { cached = undefined; }

function probeGPU(): GPUDetection {
  try {
    const output = execSync('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits', {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) return { available: false, deviceCount: 0, devices: [] };

    const lines = output.split('\n').filter(Boolean);
    const devices: string[] = [];
    let totalMemoryMb = 0;

    for (const line of lines) {
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length >= 2) {
        devices.push(parts[0]!);
        totalMemoryMb += parseInt(parts[1]!, 10) || 0;
      }
    }

    return {
      available: devices.length > 0,
      deviceCount: devices.length,
      devices,
      ...(totalMemoryMb > 0 ? { totalMemoryMb } : {}),
    };
  } catch {
    return { available: false, deviceCount: 0, devices: [] };
  }
}
