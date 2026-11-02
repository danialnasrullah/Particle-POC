// COPIED unchanged from redox-backend-nest/src/services/body-system-lookup.ts (develop @ 33940f9) so the POC
// parses Particle FHIR with the main app's real parser. On merge: delete this copy.

/**
 * Body-system lookup for medications and labs/vitals.
 *
 * Maps a medication or lab (Observation) display name to a coarse body system
 * using a case-insensitive substring match against a client-provided starter
 * table (`rule-categorization/files/body_system_lookup.json`). Matching is
 * most-specific-first (longest pattern wins), so e.g. "Iron Binding Capacity"
 * resolves before the shorter "Iron" pattern.
 *
 * This is a deterministic, best-effort enrichment: a name that matches no
 * pattern simply yields `null`. A load failure degrades gracefully to "no
 * classification" (logged, never thrown) so raw-data ingestion is never blocked
 * by a missing or malformed table.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';

import { FILES_DIR } from '../rule-categorization/engine/paths';

interface LookupEntry {
  pattern: string;
  body_system: string;
}

interface LookupTable {
  medications?: LookupEntry[];
  labs?: LookupEntry[];
}

const logger = new Logger('BodySystemLookup');
const LOOKUP_FILE = 'body_system_lookup.json';

let cache: { medications: LookupEntry[]; labs: LookupEntry[] } | null = null;

/**
 * Load and cache the lookup table. Entries are sorted by descending pattern
 * length so the most-specific substring match is found first. On any read/parse
 * error the tables fall back to empty (logged) rather than throwing.
 */
function loadTable(): { medications: LookupEntry[]; labs: LookupEntry[] } {
  if (cache) return cache;

  try {
    const raw = readFileSync(join(FILES_DIR, LOOKUP_FILE), 'utf8');
    const table = JSON.parse(raw) as LookupTable;
    const byLengthDesc = (a: LookupEntry, b: LookupEntry) =>
      b.pattern.length - a.pattern.length;

    cache = {
      medications: [...(table.medications ?? [])].sort(byLengthDesc),
      labs: [...(table.labs ?? [])].sort(byLengthDesc),
    };
  } catch (err) {
    logger.error(
      `Failed to load ${LOOKUP_FILE}; body_system enrichment disabled: ${
        (err as Error).message
      }`,
    );
    cache = { medications: [], labs: [] };
  }

  return cache;
}

function matchBodySystem(
  name: string | null | undefined,
  entries: LookupEntry[],
): string | null {
  if (!name) return null;
  const haystack = name.toLowerCase();
  for (const entry of entries) {
    if (haystack.includes(entry.pattern.toLowerCase())) {
      return entry.body_system;
    }
  }
  return null;
}

/** Resolve a body system for a medication display name, or `null` if unmatched. */
export function lookupMedicationBodySystem(
  name: string | null | undefined,
): string | null {
  return matchBodySystem(name, loadTable().medications);
}

/**
 * Resolve a body system for a lab or vital display name, or `null` if unmatched.
 * Vitals are Observations too, so they share the lab (Observation) table.
 */
export function lookupLabBodySystem(
  name: string | null | undefined,
): string | null {
  return matchBodySystem(name, loadTable().labs);
}
