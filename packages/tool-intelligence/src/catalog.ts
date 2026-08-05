// Agent tool governance catalog — risk/privacy classification for every tool
// exposed by the agent runtime. Covers the 37 default agent tools (5 core
// knowledge/graph/vector tools + 32 intelligence tools over the Phase 6/7 +
// PRX engines) plus the compute tools added by the CLI bootstrap agent
// (39 entries in total).
//
// Classification follows tool directive #18:
//   R0 read-only information · R1 low-risk generation · R2 reversible external
//   action · R3 sensitive data operation · R4 financial/infrastructure/security
//   action (human approval) · R5 potentially irreversible high-impact action.
//
// R4 tools are gated behind human approval by the tool-intelligence module
// (needsApproval / APPROVAL_REQUIRED_CLASSES).

import type { PrivacyClass, RiskClass } from './types.js';

export interface AgentToolCatalogEntry {
  /** Tool name as registered on the agent runtime (canonicalName). */
  name: string;
  displayName: string;
  riskClass: RiskClass;
  privacyClass: PrivacyClass;
  category: string;
  capabilities: string[];
  /** Human-readable rationale for the classification. */
  rationale: string;
}

/** Catalog for the 37 default agent tools. */
export const AGENT_TOOL_CATALOG: AgentToolCatalogEntry[] = [
  // ---- core knowledge / graph / vector (5) --------------------------------
  { name: 'knowledge.search', displayName: 'Knowledge Search', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'knowledge', capabilities: ['knowledge', 'search', 'retrieval'], rationale: 'Read-only retrieval over the knowledge fabric.' },
  { name: 'graph.traverse', displayName: 'Knowledge Graph Traversal', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'knowledge', capabilities: ['knowledge-graph', 'traversal'], rationale: 'Read-only graph traversal.' },
  { name: 'graph.findEntity', displayName: 'Knowledge Graph Find Entity', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'knowledge', capabilities: ['knowledge-graph', 'entity'], rationale: 'Read-only entity lookup.' },
  { name: 'graph.retrieve', displayName: 'Knowledge Graph Retrieve', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'knowledge', capabilities: ['knowledge-graph', 'retrieval'], rationale: 'Read-only context retrieval.' },
  { name: 'vector.search', displayName: 'Vector Search', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'knowledge', capabilities: ['vector', 'search'], rationale: 'Read-only embedding search.' },

  // ---- KARIS FX (2) -------------------------------------------------------
  { name: 'fx.rate', displayName: 'FX Rate', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'fx', capabilities: ['fx', 'rate'], rationale: 'Read-only exchange-rate quote.' },
  { name: 'fx.convert', displayName: 'FX Convert', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'fx', capabilities: ['fx', 'convert'], rationale: 'Pure conversion computation, no side effects.' },

  // ---- MOTO X mobility (2) ------------------------------------------------
  { name: 'mobility.dispatch', displayName: 'Mobility Dispatch', riskClass: 'R4', privacyClass: 'INTERNAL', category: 'mobility', capabilities: ['mobility', 'dispatch', 'ride'], rationale: 'Creates a fare-paying trip with real-world financial impact — requires human approval.' },
  { name: 'mobility.vehicles', displayName: 'Mobility Vehicles', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'mobility', capabilities: ['mobility', 'fleet'], rationale: 'Read-only fleet status.' },

  // ---- PORTLINK logistics (2) ---------------------------------------------
  { name: 'logistics.track', displayName: 'Logistics Track', riskClass: 'R2', privacyClass: 'INTERNAL', category: 'logistics', capabilities: ['logistics', 'tracking'], rationale: 'Appends a tracking event to a shipment — reversible external action.' },
  { name: 'logistics.shipments', displayName: 'Logistics Shipments', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'logistics', capabilities: ['logistics', 'shipments'], rationale: 'Read-only shipment listing.' },

  // ---- KARIS FARM agriculture (2) -----------------------------------------
  { name: 'agriculture.stats', displayName: 'Agriculture Stats', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'agriculture', capabilities: ['agriculture', 'analytics'], rationale: 'Read-only yield analytics.' },
  { name: 'agriculture.harvests', displayName: 'Agriculture Harvests', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'agriculture', capabilities: ['agriculture', 'harvest'], rationale: 'Read-only harvest records.' },

  // ---- KARIS LOOP circular economy (2) ------------------------------------
  { name: 'circular.stats', displayName: 'Circular Stats', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'circular', capabilities: ['circular', 'analytics'], rationale: 'Read-only circularity analytics.' },
  { name: 'circular.collections', displayName: 'Circular Collections', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'circular', capabilities: ['circular', 'collection'], rationale: 'Read-only collection records.' },

  // ---- KARIS ENERGY (2) ---------------------------------------------------
  { name: 'energy.stats', displayName: 'Energy Stats', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'energy', capabilities: ['energy', 'analytics'], rationale: 'Read-only consumption analytics.' },
  { name: 'energy.readings', displayName: 'Energy Readings', riskClass: 'R2', privacyClass: 'INTERNAL', category: 'energy', capabilities: ['energy', 'meter'], rationale: 'Records meter readings — reversible data action with monotonicity constraints.' },

  // ---- KARIS BORDER X (2) -------------------------------------------------
  { name: 'border.screen', displayName: 'Border Screen', riskClass: 'R3', privacyClass: 'CONFIDENTIAL', category: 'border', capabilities: ['border', 'screening', 'security'], rationale: 'Watchlist screening of persons — sensitive security data operation.' },
  { name: 'border.crossings', displayName: 'Border Crossings', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'border', capabilities: ['border', 'crossings'], rationale: 'Read-only crossing records.' },

  // ---- NYUMBANI KITCHEN restaurants (2) -----------------------------------
  { name: 'restaurants.menu', displayName: 'Restaurant Menu', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'restaurants', capabilities: ['restaurants', 'menu'], rationale: 'Read-only menu listing.' },
  { name: 'restaurants.orders', displayName: 'Restaurant Orders', riskClass: 'R3', privacyClass: 'INTERNAL', category: 'restaurants', capabilities: ['restaurants', 'orders'], rationale: 'Creates orders with financial totals — sensitive business action.' },

  // ---- MAZA marketplace (1) -----------------------------------------------
  { name: 'marketplace.listings', displayName: 'Marketplace Listings', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'marketplace', capabilities: ['marketplace', 'listings'], rationale: 'Read-only listing search.' },

  // ---- platform search (1) ------------------------------------------------
  { name: 'platform.search', displayName: 'Platform Search', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'search', capabilities: ['search', 'federated'], rationale: 'Read-only federated search.' },

  // ---- wallet + crypto (2) ------------------------------------------------
  { name: 'wallet.balance', displayName: 'Wallet Balance', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'wallet', capabilities: ['wallet', 'balance'], rationale: 'Read-only balance query.' },
  { name: 'crypto.balance', displayName: 'Crypto Balance', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'crypto', capabilities: ['crypto', 'balance'], rationale: 'Read-only asset balance query.' },

  // ---- PRX Part E cloud (3) -----------------------------------------------
  { name: 'cloud.instances', displayName: 'Cloud Instances', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'cloud', capabilities: ['cloud', 'instances'], rationale: 'Read-only instance listing.' },
  { name: 'cloud.provision', displayName: 'Cloud Provision', riskClass: 'R4', privacyClass: 'INTERNAL', category: 'cloud', capabilities: ['cloud', 'provision', 'infrastructure'], rationale: 'Provisions paid infrastructure with capacity consumption — requires human approval.' },
  { name: 'cloud.autoscale', displayName: 'Cloud Autoscale', riskClass: 'R4', privacyClass: 'INTERNAL', category: 'cloud', capabilities: ['cloud', 'autoscale', 'infrastructure'], rationale: 'Scales infrastructure with direct cost impact — requires human approval.' },

  // ---- PRX CDN (3) --------------------------------------------------------
  { name: 'cdn.zones', displayName: 'CDN Zones', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'cdn', capabilities: ['cdn', 'zones'], rationale: 'Read-only zone listing.' },
  { name: 'cdn.lookup', displayName: 'CDN Lookup', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'cdn', capabilities: ['cdn', 'lookup'], rationale: 'Read-only cache lookup.' },
  { name: 'cdn.purge', displayName: 'CDN Purge', riskClass: 'R2', privacyClass: 'INTERNAL', category: 'cdn', capabilities: ['cdn', 'purge'], rationale: 'Cache purge — reversible external action (assets re-cache on demand).' },

  // ---- PRX Email (3) ------------------------------------------------------
  { name: 'email.domains', displayName: 'Email Domains', riskClass: 'R0', privacyClass: 'INTERNAL', category: 'email', capabilities: ['email', 'domains'], rationale: 'Read-only domain listing.' },
  { name: 'email.send', displayName: 'Email Send', riskClass: 'R3', privacyClass: 'CONFIDENTIAL', category: 'email', capabilities: ['email', 'send', 'communication'], rationale: 'Sends external communication with content — sensitive action.' },
  { name: 'email.inbox', displayName: 'Email Inbox', riskClass: 'R0', privacyClass: 'CONFIDENTIAL', category: 'email', capabilities: ['email', 'inbox'], rationale: 'Read-only inbox listing over confidential mail.' },

  // ---- PRX RIR IPAM (3) ---------------------------------------------------
  { name: 'ipam.blocks', displayName: 'IPAM Blocks', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'ipam', capabilities: ['ipam', 'blocks'], rationale: 'Read-only block listing.' },
  { name: 'ipam.announcements', displayName: 'IPAM Announcements', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'ipam', capabilities: ['ipam', 'announcements'], rationale: 'Read-only BGP announcement listing.' },
  { name: 'ipam.stats', displayName: 'IPAM Stats', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'ipam', capabilities: ['ipam', 'analytics'], rationale: 'Read-only utilization analytics.' },

  // ---- compute (CLI bootstrap agent extras) --------------------------------
  { name: 'compute.stats', displayName: 'Compute Stats', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'compute', capabilities: ['compute', 'analytics'], rationale: 'Read-only statistical analysis over provided data.' },
  { name: 'compute.regression', displayName: 'Compute Regression', riskClass: 'R0', privacyClass: 'PUBLIC', category: 'compute', capabilities: ['compute', 'regression'], rationale: 'Read-only regression computation over provided data.' },
];

/** Index the catalog by tool name. */
export const AGENT_TOOL_CATALOG_BY_NAME: ReadonlyMap<string, AgentToolCatalogEntry> = new Map(
  AGENT_TOOL_CATALOG.map((e) => [e.name, e]),
);

/** All 37 canonical tool names in the default agent surface. */
export const AGENT_TOOL_NAMES: readonly string[] = Object.freeze(AGENT_TOOL_CATALOG.map((e) => e.name));

/** Tools that require human approval before invocation (R4/R5). */
export const APPROVAL_GATED_AGENT_TOOLS: readonly string[] = Object.freeze(
  AGENT_TOOL_CATALOG.filter((e) => e.riskClass === 'R4' || e.riskClass === 'R5').map((e) => e.name),
);
