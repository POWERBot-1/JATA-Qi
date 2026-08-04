// MessagingModule — kernel module that owns email/SMS provider instances.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { EmailProvider, SmsProvider } from './types.js';
import { SendGridProvider, TwilioProvider, AfricasTalkingProvider } from './providers.js';
import type { SendGridConfig, TwilioConfig, AfricasTalkingConfig } from './providers.js';

export interface MessagingModuleConfig {
  sendgrid?: SendGridConfig;
  twilio?: TwilioConfig;
  africasTalking?: AfricasTalkingConfig;
}

export class MessagingModule implements IModule {
  readonly id = 'messaging';
  readonly tags = ['core', 'communication'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private emails = new Map<string, EmailProvider>();
  private sms = new Map<string, SmsProvider>();

  constructor(private readonly cfg: MessagingModuleConfig = {}) {}

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    if (this.cfg.sendgrid) { const p = new SendGridProvider(this.cfg.sendgrid); this.emails.set(p.id, p); }
    if (this.cfg.twilio) { const p = new TwilioProvider(this.cfg.twilio); this.sms.set(p.id, p); }
    if (this.cfg.africasTalking) { const p = new AfricasTalkingProvider(this.cfg.africasTalking); this.sms.set(p.id, p); }
    kernel.container.registerValue('messaging', this);
    if (this.emails.size || this.sms.size) kernel.logger.info(`messaging: ${this.emails.size} email + ${this.sms.size} SMS provider(s) registered`);
  }
  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  getEmailProvider(name?: string): EmailProvider | undefined {
    if (name) return this.emails.get(name);
    return this.emails.values().next().value; // first configured
  }
  getSmsProvider(name?: string): SmsProvider | undefined {
    if (name) return this.sms.get(name);
    return this.sms.values().next().value;
  }
}
