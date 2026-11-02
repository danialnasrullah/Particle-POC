import type { CodeDto } from '../types/clinical.types';
import type { FlatRow } from '../particle/particle.types';

/**
 * Helpers for Particle Flat rows. Flat values are strings where '' means null,
 * multi-valued columns are comma- or pipe-delimited, and code systems arrive as
 * OIDs (`urn:oid:2.16.840.1.113883.6.96`) or FHIR URIs.
 */

/** Read a column as a trimmed string; '' / null / undefined -> undefined. */
export function str(row: FlatRow, key: string): string | undefined {
  const v = row[key];
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

/** Split a delimited column into unique non-empty parts. */
export function splitList(
  value: string | undefined,
  delimiter = /\s*[,|]\s*/,
): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(delimiter)) {
    const p = part.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Particle repeats a name once per source section (`"Encounter for problem, Encounter for problem"`).
 * Collapse only when the whole value is N copies of the same chunk, so names that
 * themselves contain commas (`"Heart failure, unspecified (HCC)"` x4) collapse too,
 * while genuinely different comma-separated text survives.
 */
export function collapseRepeated(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const parts = value.split(/\s*,\s*/).filter(Boolean);
  for (let copies = parts.length; copies >= 2; copies--) {
    if (parts.length % copies !== 0) continue;
    const size = parts.length / copies;
    const chunk = parts.slice(0, size).join(', ');
    let same = true;
    for (let i = size; i < parts.length && same; i += size) {
      same = parts.slice(i, i + size).join(', ') === chunk;
    }
    if (same) return chunk;
  }
  return value;
}

/** Particle uses placeholder units like `no_unit`; treat them as absent. */
export function cleanUnit(unit: string | undefined): string | undefined {
  if (!unit || /^(no_unit|none|null|unknown|1)$/i.test(unit)) return undefined;
  return unit;
}

/**
 * Parse the date formats seen in Flat data into a Date:
 * `2011-05-28T15:19:11+0000`, `1970-12-26 00:00:00.000000+00:00`,
 * `2026-02-06T02:41:44.378318936Z`, `2011-05-28`, and `", 2011-05-28T..."` (leading empty slot).
 */
export function parseFlatDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const first = value
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  if (!first) return undefined;

  let s = first.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2');
  s = s.replace(/(\.\d{3})\d+/, '$1');
  s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const OID_TO_URI: Record<string, string> = {
  '2.16.840.1.113883.6.96': 'http://snomed.info/sct',
  '2.16.840.1.113883.6.90': 'http://hl7.org/fhir/sid/icd-10-cm',
  '2.16.840.1.113883.6.3': 'http://hl7.org/fhir/sid/icd-10',
  '2.16.840.1.113883.6.103': 'http://hl7.org/fhir/sid/icd-9-cm',
  '2.16.840.1.113883.6.1': 'http://loinc.org',
  '2.16.840.1.113883.6.88': 'http://www.nlm.nih.gov/research/umls/rxnorm',
  '2.16.840.1.113883.6.69': 'http://hl7.org/fhir/sid/ndc',
  '2.16.840.1.113883.6.12': 'http://www.ama-assn.org/go/cpt',
  '2.16.840.1.113883.6.285':
    'https://www.cms.gov/medicare/coding/hcpcsreleasecodesets',
  '2.16.840.1.113883.12.292': 'http://hl7.org/fhir/sid/cvx',
  '2.16.840.1.113883.6.8': 'http://unitsofmeasure.org',
};

/** Map an OID / urn:oid to the FHIR canonical URI the main-app parser keys on; pass other URIs through. */
export function codeSystemUri(system: string | undefined): string {
  if (!system) return 'unknown';
  const oid = system.replace(/^urn:oid:/i, '').trim();
  return OID_TO_URI[oid] ?? system.trim();
}

/**
 * Pair a delimited code column with its (slot-aligned) system column.
 * When only one system is given it applies to every code.
 */
export function pairCodes(
  codes: string | undefined,
  systems: string | undefined,
): CodeDto[] {
  const codeList = codes ? codes.split(/\s*[,|]\s*/).map((c) => c.trim()) : [];
  const systemList = systems
    ? systems.split(/\s*,\s*/).map((s) => s.trim())
    : [];
  const out: CodeDto[] = [];
  codeList.forEach((value, i) => {
    if (!value) return;
    const system = codeSystemUri(systemList[i] ?? systemList[0]);
    if (!out.some((c) => c.value === value && c.system === system)) {
      out.push({ system, value });
    }
  });
  return out;
}

/** Add IMO-normalised codes (populated when Particle's IMO enrichment is enabled). */
export function withNormalisedCodes(
  base: CodeDto[],
  row: FlatRow,
  columns: { column: string; system: string }[],
): CodeDto[] {
  const out = [...base];
  for (const { column, system } of columns) {
    for (const value of splitList(str(row, column))) {
      if (!out.some((c) => c.value === value && c.system === system)) {
        out.push({ system, value });
      }
    }
  }
  return out;
}

/** Strip CDA narrative XML to readable text for ClinicalNoteDto. */
export function xmlToText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(paragraph|p|tr|item|li|content)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return text || undefined;
}

/** Index rows by a key column; for comma-delimited key columns every part is indexed. */
export function indexBy(
  rows: FlatRow[] | undefined,
  key: string,
  multi = false,
): Map<string, FlatRow> {
  const map = new Map<string, FlatRow>();
  for (const row of rows ?? []) {
    const raw = str(row, key);
    if (!raw) continue;
    const keys = multi ? splitList(raw, /\s*,\s*/) : [raw];
    for (const k of keys) if (!map.has(k)) map.set(k, row);
  }
  return map;
}

export const SYSTEMS = {
  SNOMED: 'http://snomed.info/sct',
  ICD10CM: 'http://hl7.org/fhir/sid/icd-10-cm',
  LOINC: 'http://loinc.org',
  RXNORM: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  NDC: 'http://hl7.org/fhir/sid/ndc',
  CPT: 'http://www.ama-assn.org/go/cpt',
  CVX: 'http://hl7.org/fhir/sid/cvx',
} as const;
