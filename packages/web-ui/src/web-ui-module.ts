// WebUIModule — registers static admin dashboard files with the kernel so the
// API gateway can serve them. The UI is pure HTML/CSS/vanilla-JS (no build
// step) and uses the SDK pattern (fetch calls to the same-origin API).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KernelApi, IModule } from '@jataqi/core-kernel';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export class WebUIModule implements IModule {
  readonly id = 'web-ui';
  readonly tags = ['core', 'ui'] as const;
  readonly dependsOn = [] as const;

  private publicDir: string;

  constructor() {
    // Resolve the public directory relative to the compiled module.
    // In dev: packages/web-ui/public; in dist: packages/web-ui/public (not compiled).
    const devPath = join(__dirname, '..', 'public');
    const distPath = join(__dirname, '..', '..', 'public');
    this.publicDir = existsSync(devPath) ? devPath : distPath;
  }

  async init(kernel: KernelApi): Promise<void> {
    kernel.container.registerValue('web-ui', this);
    kernel.logger.info(`web-ui module initialized (public: ${this.publicDir})`);
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  /** Serve a static file from the public directory. Returns undefined if not found. */
  serve(pathname: string): { content: Buffer; contentType: string } | undefined {
    // Normalize: /ui → index.html, /ui/ → index.html
    let clean = pathname.replace(/^\/ui\/?/, '');
    if (clean === '' || clean === '/') clean = 'index.html';
    // Security: prevent path traversal.
    if (clean.includes('..')) return undefined;
    const filePath = join(this.publicDir, clean);
    if (!existsSync(filePath)) return undefined;
    const content = readFileSync(filePath);
    const contentType = MIME[extname(filePath)] ?? 'application/octet-stream';
    return { content, contentType };
  }

  /** List all available static files (for testing). */
  listFiles(): string[] {
    if (!existsSync(this.publicDir)) return [];
    return readdirSync(this.publicDir).filter((f) => !f.startsWith('.'));
  }
}
