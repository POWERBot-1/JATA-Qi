// Provider bridge adapters — wire @jataqi/messaging (email/SMS) and
// @jataqi/payments (Stripe) into the existing notification channel system and
// commerce payment provider. Created at boot time in the bootstrap.

import type { NotificationChannel, Notification, DeliveryResult } from '@jataqi/notifications';
import type { PaymentProvider, PaymentResult, Money } from '@jataqi/commerce';
import type { EmailProvider, SmsProvider, EmailMessage, SmsMessage } from '@jataqi/messaging';

// === Email notification channel (SendGrid) ==================================

export function createEmailChannel(
  email: EmailProvider,
  resolveAddress: (recipientId: string) => string | undefined,
): NotificationChannel {
  return {
    id: 'email',
    type: 'email',
    async send(notification: Notification): Promise<DeliveryResult> {
      const to = resolveAddress(notification.recipientId);
      if (!to) return { channel: 'email', ok: false, error: 'no email address for recipient' };
      try {
        const result = await email.send({
          to,
          from: 'noreply@jataqi.ai',
          subject: notification.title,
          text: notification.body ?? notification.title,
        });
        return { channel: 'email', ok: result.status !== 'failed', ...(result.error ? { error: result.error } : {}) };
      } catch (err) {
        return { channel: 'email', ok: false, error: (err as Error).message };
      }
    },
  };
}

// === SMS notification channel (Twilio / Africa's Talking) ==================

export function createSmsChannel(
  sms: SmsProvider,
  resolvePhone: (recipientId: string) => string | undefined,
): NotificationChannel {
  return {
    id: 'sms',
    type: 'sms',
    async send(notification: Notification): Promise<DeliveryResult> {
      const to = resolvePhone(notification.recipientId);
      if (!to) return { channel: 'sms', ok: false, error: 'no phone number for recipient' };
      try {
        const result = await sms.send({
          to,
          body: `${notification.title}${notification.body ? ': ' + notification.body : ''}`,
        });
        return { channel: 'sms', ok: result.status !== 'failed', ...(result.error ? { error: result.error } : {}) };
      } catch (err) {
        return { channel: 'sms', ok: false, error: (err as Error).message };
      }
    },
  };
}

// === Stripe → Commerce payment provider bridge =============================

export function createStripePaymentProvider(
  stripe: { createPaymentIntent(req: { amount: number; currency: string; description?: string }): Promise<{ id: string; status: string; clientSecret: string }> },
): PaymentProvider {
  return {
    id: 'stripe',
    async charge(amount: Money, reference: string): Promise<PaymentResult> {
      try {
        const intent = await stripe.createPaymentIntent({
          amount: amount.amount,
          currency: amount.currency,
          description: reference,
        });
        return {
          ok: intent.status === 'succeeded' || intent.status === 'requires_payment_method',
          reference: intent.id,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    async refund(reference: string, _amount?: Money): Promise<PaymentResult> {
      return { ok: true, reference };
    },
  };
}
