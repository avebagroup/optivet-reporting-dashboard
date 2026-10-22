/**
 * fields.js - finds the custom fields the dashboard reads, and decodes values.
 *
 * The brief names four fields: "Product Requested", "VA Location/Facility",
 * "State", "Postal Mailer". The OptiVet account spells them differently, so
 * each slot has an ordered list of patterns. Exact brief names win, then the
 * live OptiVet equivalents. Several fields can back one slot (first non-empty
 * value per contact wins). The resolved mapping is returned to the page so
 * the reader can see exactly which fields produced the numbers.
 *
 * Override from the environment with FIELD_PRODUCT, FIELD_FACILITY,
 * FIELD_STATE, FIELD_POSTAL (comma-separated field names or IDs).
 */

const SLOTS = {
  product: {
    label: 'Product Requested',
    patterns: [
      /^product(s)? requested$/i,
      /^00\. summary of device requested$/i,
      /summary of device requested/i,
      /device(s)? requested/i,
    ],
  },
  facility: {
    label: 'VA Location/Facility',
    patterns: [
      /^va location\s*\/\s*facility$/i,
      /^va location$/i,
      /^va facility - standard name$/i,
      /^00\. va medical center in the state$/i,
      /va medical center in the state/i,
      /facility/i,
    ],
    multi: true,
  },
  state: {
    label: 'State',
    patterns: [
      /^state$/i,
      /^reporting - va medical center state$/i,
      /^00\. va medical center state$/i,
      /^00\. community center state$/i,
      /va medical center state/i,
      /community center state/i,
    ],
    multi: true,
  },
  postal: {
    label: 'Postal Mailer',
    patterns: [
      /^postal mailer$/i,
      /postal mailer/i,
      /^00\. prefers physical packet$/i,
      /prefers physical packet/i,
      /physical (mail|packet)/i,
      /mailer/i,
    ],
    multi: true,
  },
};

// Tags that also mean "this lead gets a postal mailer".
export const POSTAL_TAGS = ['physical mail', 'postcard mailer', 'manual physical mail'];

/** Codes seen in "00. Summary of Device Requested" and the product tags. */
const PRODUCT_ALIASES = [
  ['Vx Therapy (VR)', ['vx', 'vx therapy', 'vr', 'virtual reality therapy device', 'virtual reality']],
  ['OnLux (Red Light Therapy)', ['onlux', 'rlt', 'red light therapy device', 'red light therapy devices', 'red light therapy', 'red light']],
  ['PEMF Wearable', ['pemf', 'pmf', 'pemf wearable']],
  ['eNeura (Migraine)', ['eneura', 'ene', 'migraine therapy device', 'migraine relief device', 'migraine']],
  ['Vielight', ['vielight', 'vlt', 'brain & vagus', 'brain and vagus']],
  ['Neurofeedback', ['neurofeedback', 'nfb', 'at-home neurofeedback', 'at home neurofeedback']],
  ['MedaCube', ['medacube', 'mdc', 'medacube automatic pill dispenser']],
  ['PlasmaFlow', ['plasmaflow', 'plasma flow']],
];
const PRODUCT_LOOKUP = new Map();
for (const [name, aliases] of PRODUCT_ALIASES) {
  for (const a of aliases) PRODUCT_LOOKUP.set(a, name);
}
export const PRODUCT_TAGS = ['vx therapy', 'onlux', 'pemf wearable', 'eneura', 'vielight', 'neurofeedback', 'medacube', 'plasmaflow', 'vr'];

export function resolveFields(customFields, overrides = {}) {
  const fields = (customFields || []).filter((f) => f && f.id && f.name);
  const result = {};
  for (const [slot, spec] of Object.entries(SLOTS)) {
    let chosen = [];
    const override = String(overrides[slot] || '').trim();
    if (override) {
      const wanted = override.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      chosen = fields.filter((f) => wanted.includes(f.id.toLowerCase()) || wanted.includes(f.name.toLowerCase()));
    } else {
      const picked = new Set();
      for (const re of spec.patterns) {
        for (const f of fields) {
          if (!picked.has(f.id) && re.test(f.name)) {
            picked.add(f.id);
            chosen.push(f);
            if (!spec.multi) break;
          }
        }
        if (!spec.multi && chosen.length) break;
      }
    }
    result[slot] = {
      label: spec.label,
      fields: chosen.map((f) => ({ id: f.id, name: f.name, dataType: f.dataType || null })),
      source: override ? 'override' : chosen.length ? 'matched' : 'missing',
    };
  }
  return result;
}

function contactFieldMap(contact) {
  const m = new Map();
  for (const cf of contact?.customFields || []) {
    if (cf && cf.id !== undefined) m.set(cf.id, cf.value ?? cf.field_value ?? null);
  }
  return m;
}

function firstNonEmpty(fieldMap, slot) {
  for (const f of slot.fields) {
    const v = fieldMap.get(f.id);
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      const arr = v.filter((x) => x !== null && x !== undefined && String(x).trim() !== '');
      if (arr.length) return arr;
      continue;
    }
    if (typeof v === 'object') continue;
    if (String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

export function normalizeProduct(code) {
  const key = String(code || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  if (PRODUCT_LOOKUP.has(key)) return PRODUCT_LOOKUP.get(key);
  // Unknown code: pass it through, title-cased, so nothing is silently dropped.
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

function splitList(value) {
  if (Array.isArray(value)) return value.flatMap(splitList);
  return String(value)
    .split(/[,;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Decode one contact into the attributes the dashboard needs.
 * `products` is a de-duplicated list of product names.
 */
export function decodeContact(contact, mapping) {
  const fm = contactFieldMap(contact);
  const tags = (contact.tags || []).map((t) => String(t).toLowerCase());

  // Products: the summary field first, then product tags as a fallback.
  let productSource = 'field';
  let raw = mapping.product.fields.length ? firstNonEmpty(fm, mapping.product) : null;
  let products = raw ? splitList(raw).map(normalizeProduct).filter(Boolean) : [];
  if (!products.length) {
    products = PRODUCT_TAGS.filter((t) => tags.includes(t)).map(normalizeProduct);
    productSource = products.length ? 'tags' : 'none';
  }
  products = [...new Set(products)];

  const facilityRaw = firstNonEmpty(fm, mapping.facility);
  const facility = facilityRaw ? String(Array.isArray(facilityRaw) ? facilityRaw[0] : facilityRaw).trim() : null;

  let stateRaw = firstNonEmpty(fm, mapping.state);
  let state = stateRaw ? String(Array.isArray(stateRaw) ? stateRaw[0] : stateRaw).trim() : null;
  if (!state && contact.state && String(contact.state).trim()) state = String(contact.state).trim();

  const postalRaw = firstNonEmpty(fm, mapping.postal);
  const postalField = postalRaw !== null && isTruthy(postalRaw);
  const postalTag = POSTAL_TAGS.some((t) => tags.includes(t));

  const carePath = detectCarePath(fm, tags);

  return {
    id: contact.id,
    name: [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || contact.contactName || contact.email || contact.phone || '(no name)',
    createdAt: contact.dateAdded,
    products,
    productSource,
    facility,
    state,
    postal: postalField || postalTag,
    postalVia: postalField && postalTag ? 'field+tag' : postalField ? 'field' : postalTag ? 'tag' : null,
    carePath,
  };
}

function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  const s = String(v).trim().toLowerCase();
  return !['', 'no', 'false', '0', 'n', 'none', 'off'].includes(s);
}

function detectCarePath(fm, tags) {
  for (const [, v] of fm) {
    if (typeof v !== 'string') continue;
    const s = v.toLowerCase();
    if (s === 'community care' || s === 'community care partner') return 'Community Care';
    if (s === 'va medical center') return 'VA Medical Center';
  }
  if (tags.includes('community care partner')) return 'Community Care';
  return null;
}
