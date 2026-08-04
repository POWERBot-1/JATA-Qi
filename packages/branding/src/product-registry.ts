// Product Registry — predefined brand kits for all 15 JATA Qi products. Each
// product has a unique palette, typography, logo glyph, and shape — all derived
// from the shared design system so they're individually distinct yet clearly
// belong to the JATA Qi ecosystem.

import type { BrandKit } from './types.js';

/** All 15 JATA Qi products with their brand identities. */
export const PRODUCT_BRANDS: Record<string, BrandKit> = {
  'jata-qi': {
    productId: 'jata-qi', productName: 'JATA Qi', tagline: 'The Universal AI Operating System',
    palette: { primary: '#5b5bd6', primaryDim: '#4a4ac0', secondary: '#0ea5e9', accent: '#f472b6', background: '#0c0e1a', surface: '#15182a', text: '#e7e9f5' },
    typography: { displayFont: "'SF Pro Display', 'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 700, bodyWeight: 400 },
    logoGlyph: 'Q', logoShape: 'hexagon', createdAt: 0,
  },
  'soma-ai': {
    productId: 'soma-ai', productName: 'SOMA AI', tagline: 'Intelligent Automation Engine',
    palette: { primary: '#06b6d4', primaryDim: '#0891b2', secondary: '#8b5cf6', accent: '#f59e0b', background: '#0a1929', surface: '#102a43', text: '#e0f2fe' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 700, bodyWeight: 400 },
    logoGlyph: 'S', logoShape: 'circle', createdAt: 0,
  },
  'tanya-ai': {
    productId: 'tanya-ai', productName: 'TANYA AI', tagline: 'Conversational Intelligence',
    palette: { primary: '#ec4899', primaryDim: '#db2777', secondary: '#8b5cf6', accent: '#06b6d4', background: '#1a0a1a', surface: '#2a1030', text: '#fce7f3' },
    typography: { displayFont: "'Poppins', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 600, bodyWeight: 400 },
    logoGlyph: 'T', logoShape: 'diamond', createdAt: 0,
  },
  'power-bot-x': {
    productId: 'power-bot-x', productName: 'POWER BOT X', tagline: 'Autonomous Operations',
    palette: { primary: '#f97316', primaryDim: '#ea580c', secondary: '#dc2626', accent: '#fbbf24', background: '#1a1000', surface: '#2a1800', text: '#fef3c7' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 800, bodyWeight: 400 },
    logoGlyph: 'P', logoShape: 'shield', createdAt: 0,
  },
  'moto-x': {
    productId: 'moto-x', productName: 'MOTO X', tagline: 'Mobility Intelligence',
    palette: { primary: '#dc2626', primaryDim: '#b91c1c', secondary: '#1e293b', accent: '#fbbf24', background: '#0f0f0f', surface: '#1e1e1e', text: '#fafafa' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 900, bodyWeight: 400 },
    logoGlyph: 'M', logoShape: 'triangle', createdAt: 0,
  },
  'karis-farm': {
    productId: 'karis-farm', productName: 'KARIS FARM', tagline: 'Agricultural Intelligence',
    palette: { primary: '#16a34a', primaryDim: '#15803d', secondary: '#84cc16', accent: '#f59e0b', background: '#0a1f0a', surface: '#142a14', text: '#dcfce7' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 700, bodyWeight: 400 },
    logoGlyph: 'K', logoShape: 'hexagon', createdAt: 0,
  },
  'karis-loop': {
    productId: 'karis-loop', productName: 'KARIS LOOP', tagline: 'Circular Economy Platform',
    palette: { primary: '#0d9488', primaryDim: '#0f766e', secondary: '#84cc16', accent: '#06b6d4', background: '#021f1c', surface: '#042f2a', text: '#ccfbf1' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 700, bodyWeight: 400 },
    logoGlyph: 'L', logoShape: 'circle', createdAt: 0,
  },
  'karis-energy': {
    productId: 'karis-energy', productName: 'KARIS ENERGY', tagline: 'Energy Intelligence',
    palette: { primary: '#eab308', primaryDim: '#ca8a04', secondary: '#f97316', accent: '#22c55e', background: '#1a1a00', surface: '#2a2a00', text: '#fef9c3' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 700, bodyWeight: 400 },
    logoGlyph: 'E', logoShape: 'triangle', createdAt: 0,
  },
  'karis-border-x': {
    productId: 'karis-border-x', productName: 'KARIS BORDER X', tagline: 'Border Security Intelligence',
    palette: { primary: '#1e40af', primaryDim: '#1e3a8a', secondary: '#0ea5e9', accent: '#ef4444', background: '#0a0e2a', surface: '#121838', text: '#dbeafe' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 800, bodyWeight: 400 },
    logoGlyph: 'B', logoShape: 'shield', createdAt: 0,
  },
  'karis-fx': {
    productId: 'karis-fx', productName: 'KARIS FX', tagline: 'Foreign Exchange Intelligence',
    palette: { primary: '#7c3aed', primaryDim: '#6d28d9', secondary: '#06b6d4', accent: '#10b981', background: '#100a2a', surface: '#181040', text: '#ede9fe' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 700, bodyWeight: 400 },
    logoGlyph: 'F', logoShape: 'diamond', createdAt: 0,
  },
  'maza': {
    productId: 'maza', productName: 'MAZA', tagline: 'Marketplace Intelligence',
    palette: { primary: '#ea580c', primaryDim: '#c2410c', secondary: '#f59e0b', accent: '#16a34a', background: '#1a0f00', surface: '#2a1800', text: '#fed7aa' },
    typography: { displayFont: "'Poppins', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 700, bodyWeight: 400 },
    logoGlyph: 'M', logoShape: 'circle', createdAt: 0,
  },
  'nova': {
    productId: 'nova', productName: 'NOVA', tagline: 'Game Creation & Simulation',
    palette: { primary: '#8b5cf6', primaryDim: '#7c3aed', secondary: '#ec4899', accent: '#06b6d4', background: '#0a0518', surface: '#150a30', text: '#e9d5ff' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 700, bodyWeight: 400 },
    logoGlyph: 'N', logoShape: 'hexagon', createdAt: 0,
  },
  'portlink': {
    productId: 'portlink', productName: 'PORTLINK', tagline: 'Logistics & Port Intelligence',
    palette: { primary: '#0284c7', primaryDim: '#0369a1', secondary: '#0ea5e9', accent: '#f97316', background: '#021829', surface: '#042a43', text: '#bae6fd' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 700, bodyWeight: 400 },
    logoGlyph: 'P', logoShape: 'square', createdAt: 0,
  },
  'nyumbani-kitchen': {
    productId: 'nyumbani-kitchen', productName: 'NYUMBANI KITCHEN', tagline: 'Restaurant Intelligence',
    palette: { primary: '#dc2626', primaryDim: '#b91c1c', secondary: '#f59e0b', accent: '#16a34a', background: '#1a0505', surface: '#2a0a0a', text: '#fee2e2' },
    typography: { displayFont: "'Poppins', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 600, bodyWeight: 400 },
    logoGlyph: 'N', logoShape: 'circle', createdAt: 0,
  },
  'krt-wallet': {
    productId: 'krt-wallet', productName: 'KRT Wallet', tagline: 'Digital Asset Wallet',
    palette: { primary: '#10b981', primaryDim: '#059669', secondary: '#06b6d4', accent: '#fbbf24', background: '#021a10', surface: '#042a18', text: '#d1fae5' },
    typography: { displayFont: "'Inter', sans-serif", bodyFont: "'Inter', sans-serif", monoFont: "'JetBrains Mono', monospace", displayWeight: 700, bodyWeight: 400 },
    logoGlyph: 'K', logoShape: 'shield', createdAt: 0,
  },
};

/** Get a product's brand kit. */
export function getBrand(productId: string): BrandKit | undefined {
  return PRODUCT_BRANDS[productId];
}

/** List all product IDs. */
export function listProducts(): string[] {
  return Object.keys(PRODUCT_BRANDS);
}
