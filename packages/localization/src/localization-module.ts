// LocalizationModule — multi-language, multi-currency, date/number formatting (#44).
import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';

export interface LocaleEntry { id: string; code: string; displayName: string; rtl?: boolean; }
export interface CurrencyEntry { id: string; code: string; symbol: string; precision: number; }
export interface TranslationEntry { id: string; locale: string; key: string; value: string; }

export class LocalizationModule implements IModule {
  readonly id = 'localization'; readonly tags = ['core', 'platform'] as const; readonly dependsOn = ['storage'] as const;
  private api!: KernelApi; private locales!: ICollection<LocaleEntry>;
  private currencies!: ICollection<CurrencyEntry>; private translations!: ICollection<TranslationEntry>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as { collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>> };
    this.locales = await storage.collection<LocaleEntry>('loc.locales');
    this.currencies = await storage.collection<CurrencyEntry>('loc.currencies');
    this.translations = await storage.collection<TranslationEntry>('loc.translations');
    // Seed defaults.
    if ((await this.locales.count()) === 0) {
      for (const l of [{ code: 'en', display: 'English' }, { code: 'sw', display: 'Kiswahili' }, { code: 'fr', display: 'Français' }, { code: 'ar', display: 'العربية', rtl: true }]) {
        await this.locales.put({ id: l.code, code: l.code, displayName: l.display, ...(l.rtl ? { rtl: true } : {}) });
      }
    }
    if ((await this.currencies.count()) === 0) {
      for (const c of [{ code: 'USD', symbol: '$', precision: 2 }, { code: 'KES', symbol: 'KSh', precision: 2 }, { code: 'EUR', symbol: '€', precision: 2 }, { code: 'GBP', symbol: '£', precision: 2 }]) {
        await this.currencies.put({ id: c.code, code: c.code, symbol: c.symbol, precision: c.precision });
      }
    }
    kernel.container.registerValue('localization', this);
    kernel.logger.info('localization module initialized');
  }
  async start(_k: KernelApi): Promise<void> {} async stop(_k: KernelApi): Promise<void> {}

  async listLocales(): Promise<LocaleEntry[]> { return this.locales.all(); }
  async addLocale(code: string, displayName: string, rtl?: boolean): Promise<LocaleEntry> {
    const l: LocaleEntry = { id: code, code, displayName, ...(rtl ? { rtl } : {}) };
    await this.locales.put(l); return l;
  }
  async listCurrencies(): Promise<CurrencyEntry[]> { return this.currencies.all(); }
  async addCurrency(code: string, symbol: string, precision: number): Promise<CurrencyEntry> {
    const c: CurrencyEntry = { id: code, code, symbol, precision };
    await this.currencies.put(c); return c;
  }

  async setTranslation(locale: string, key: string, value: string): Promise<TranslationEntry> {
    const existing = (await this.translations.all()).find((t) => t.locale === locale && t.key === key);
    const t: TranslationEntry = { id: existing?.id ?? randomUUID(), locale, key, value };
    await this.translations.put(t); return t;
  }
  async getTranslation(locale: string, key: string): Promise<string | undefined> {
    const t = (await this.translations.all()).find((t) => t.locale === locale && t.key === key);
    return t?.value;
  }
  /** Translate with fallback to the key if no translation found. */
  async t(locale: string, key: string): Promise<string> { return (await this.getTranslation(locale, key)) ?? key; }
  /** Translate with variable interpolation: t('en', 'welcome', { name: 'Alice' }) → 'Hi Alice' */
  async tv(locale: string, key: string, vars?: Record<string, string>): Promise<string> {
    let val = await this.t(locale, key);
    if (vars) for (const [k, v] of Object.entries(vars)) val = val.replaceAll(`{${k}}`, v);
    return val;
  }

  /** Format a monetary amount with the currency's symbol and precision. */
  async formatMoney(amount: number, currencyCode: string): Promise<string> {
    const all = await this.currencies.all();
    const c = all.find((cur) => cur.code === currencyCode);
    return c ? `${c.symbol}${amount.toFixed(c.precision)}` : `${amount.toFixed(2)} ${currencyCode}`;
  }
  /** Format a date as ISO (locale-aware formatting can be extended). */
  formatDate(date: Date | number, locale?: string): string {
    const d = typeof date === 'number' ? new Date(date) : date;
    return d.toISOString().slice(0, 10);
  }
}
