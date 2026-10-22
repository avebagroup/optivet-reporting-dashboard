/**
 * report.js - pulls the raw records and turns them into the dashboard numbers.
 *
 * Nothing here is written back to GoHighLevel. The output is one JSON object
 * the page renders directly.
 */
import { GhlError } from './ghl.js';
import { resolveFields, decodeContact } from './fields.js';
import { dayKey, listDays } from './tz.js';

const KPI_KEYS = ['newLeads', 'productsRequested', 'callsIn', 'callsOut', 'smsIn', 'smsOut', 'postalMailers'];

export async function buildReport({ ghl, config, from, to, tz, startMs, endMs, meta }) {
  const warnings = [];
  const t0 = Date.now();
  const callsBefore = ghl.calls;

  // Reference data (users, fields) is small; fetch alongside the heavy pulls.
  const [users, customFields, contactsRes, messagesRes] = await Promise.all([
    ghl.getUsers(),
    ghl.getCustomFields(),
    ghl.getContactsAddedBetween(startMs, endMs),
    fetchMessages(ghl, config, startMs, endMs, warnings, tz),
  ]);

  const userNames = new Map();
  for (const u of users) {
    const name = u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id;
    userNames.set(u.id, { name, email: u.email || null, deleted: !!u.deleted });
  }

  const mapping = resolveFields(customFields, config.fieldOverrides);
  for (const [slot, m] of Object.entries(mapping)) {
    if (!m.fields.length) warnings.push(`No custom field matched "${m.label}" (${slot}). Set FIELD_${slot.toUpperCase()} to the field name or ID.`);
  }

  /* ---------------- leads ---------------- */
  const leads = contactsRes.contacts
    .filter((c) => {
      const t = Date.parse(c.dateAdded);
      return !Number.isNaN(t) && t >= startMs && t <= endMs;
    })
    .map((c) => decodeContact(c, mapping));
  if (contactsRes.total > contactsRes.contacts.length) {
    warnings.push(`GoHighLevel reported ${contactsRes.total} contacts in range but returned ${contactsRes.contacts.length}.`);
  }

  /* ---------------- messages ---------------- */
  const messages = normalizeMessages(messagesRes.messages);
  attributeInbound(messages);

  /* ---------------- daily buckets ---------------- */
  const days = listDays(from, to);
  const daily = new Map(days.map((d) => [d, Object.fromEntries(KPI_KEYS.map((k) => [k, 0]))]));
  const bump = (ms, key, n = 1) => {
    const row = daily.get(dayKey(ms, tz));
    if (row) row[key] += n;
  };

  const productCounts = new Map();
  const facilityRows = new Map();
  let leadsWithFacility = 0;
  let leadsWithProductFromTags = 0;
  const dataQuality = [];

  for (const l of leads) {
    const ms = Date.parse(l.createdAt);
    bump(ms, 'newLeads');
    bump(ms, 'productsRequested', l.products.length);
    if (l.postal) bump(ms, 'postalMailers');
    if (l.productSource === 'tags') leadsWithProductFromTags++;

    for (const p of l.products) productCounts.set(p, (productCounts.get(p) || 0) + 1);

    if (l.facility) {
      leadsWithFacility++;
      const key = l.facility.toLowerCase();
      if (!facilityRows.has(key)) facilityRows.set(key, { facility: l.facility, state: l.state || null, leads: 0, counts: {}, total: 0 });
      const row = facilityRows.get(key);
      row.leads++;
      if (!row.state && l.state) row.state = l.state;
      for (const p of l.products) {
        row.counts[p] = (row.counts[p] || 0) + 1;
        row.total++;
      }
    }

    const missing = [];
    if (!l.facility) missing.push('VA location');
    if (!l.state) missing.push('State');
    if (missing.length) {
      dataQuality.push({ id: l.id, name: l.name, createdAt: l.createdAt, missing, carePath: l.carePath, products: l.products });
    }
  }

  const team = new Map();
  const teamRow = (id) => {
    if (!team.has(id)) team.set(id, { userId: id, callsIn: 0, callsOut: 0, smsIn: 0, smsOut: 0, total: 0 });
    return team.get(id);
  };
  let inboundByHeuristic = 0;
  for (const m of messages) {
    const key = m.type === 'call' ? (m.direction === 'inbound' ? 'callsIn' : 'callsOut') : m.direction === 'inbound' ? 'smsIn' : 'smsOut';
    bump(m.dateAdded, key);
    const row = teamRow(m.userId || '__unattributed');
    row[key]++;
    row.total++;
    if (m.attributedBy === 'conversation') inboundByHeuristic++;
  }

  const kpis = Object.fromEntries(KPI_KEYS.map((k) => [k, 0]));
  for (const row of daily.values()) for (const k of KPI_KEYS) kpis[k] += row[k];

  const products = [...productCounts.entries()]
    .map(([product, count]) => ({ product, count }))
    .sort((a, b) => b.count - a.count || a.product.localeCompare(b.product));
  const productOrder = products.map((p) => p.product);

  const facilities = [...facilityRows.values()]
    .map((r) => ({ ...r, counts: Object.fromEntries(productOrder.map((p) => [p, r.counts[p] || 0])) }))
    .sort((a, b) => b.total - a.total || b.leads - a.leads || a.facility.localeCompare(b.facility));

  const teamRows = [...team.values()]
    .map((r) => {
      const u = r.userId === '__unattributed' ? null : userNames.get(r.userId);
      return {
        ...r,
        name: r.userId === '__unattributed' ? 'Automations / unattributed' : u ? u.name : `Unknown user (${r.userId})`,
        email: u?.email || null,
        isSystem: r.userId === '__unattributed',
        isUnknown: r.userId !== '__unattributed' && !u,
      };
    })
    .sort((a, b) => (a.isSystem - b.isSystem) || b.total - a.total || a.name.localeCompare(b.name));

  dataQuality.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    apiCalls: ghl.calls - callsBefore,
    range: { from, to, tz, startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString(), days: days.length },
    account: meta,
    sources: {
      messages: messagesRes.source,
      messagesNote: messagesRes.note,
      contactsTotalReported: contactsRes.total,
      messagesCount: messages.length,
    },
    fieldMap: mapping,
    warnings,
    kpis,
    daily: days.map((d) => ({ date: d, ...daily.get(d) })),
    team: {
      rows: teamRows,
      inboundAttributedByConversation: inboundByHeuristic,
      note: 'Outbound calls and texts are credited to the user GoHighLevel stamped on the message. Inbound messages carry no user ID, so each one is credited to the teammate who most recently called or texted that contact inside the selected range; anything left (and all workflow/automation sends) sits in the Automations / unattributed row.',
    },
    products: {
      rows: products,
      totalRequests: kpis.productsRequested,
      leadsWithAnyProduct: leads.filter((l) => l.products.length).length,
      leadsFromTags: leadsWithProductFromTags,
      note: 'One lead can request several devices; each request counts once. Codes in the product field (vx, rlt, pmf, ene, vlt, nfb, mdc...) are translated to product names. Leads with an empty product field fall back to their product tags.',
    },
    facilities: {
      rows: facilities,
      products: productOrder,
      leadsTotal: leads.length,
      leadsWithFacility,
      pctWithFacility: leads.length ? Math.round((leadsWithFacility / leads.length) * 1000) / 10 : 0,
      communityCareLeads: leads.filter((l) => l.carePath === 'Community Care').length,
    },
    dataQuality: {
      rows: dataQuality,
      total: dataQuality.length,
      missingFacility: dataQuality.filter((r) => r.missing.includes('VA location')).length,
      missingState: dataQuality.filter((r) => r.missing.includes('State')).length,
    },
  };
}

/* ------------------------------------------------------------------ */

async function fetchMessages(ghl, config, startMs, endMs, warnings, tz) {
  const mode = config.messageSource;
  if (mode !== 'walk') {
    try {
      const [sms, calls] = await Promise.all([
        ghl.exportMessages('SMS', startMs, endMs),
        ghl.exportMessages('Call', startMs, endMs),
      ]);
      for (const r of [sms, calls]) {
        const days = (list) => list.map((iso) => dayKey(Date.parse(iso), tz)).join(', ');
        if (r.suspectWindows.length) {
          warnings.push(`No ${r.channel} records came back for ${days(r.suspectWindows)} (asked 5 times over half a minute, so most likely a genuinely quiet day). If that day should have ${r.channel === 'Call' ? 'calls' : 'texts'}, press Refresh.`);
        }
        if (r.shortWindows.length) {
          warnings.push(`GoHighLevel reported more ${r.channel} messages than it returned for ${days(r.shortWindows)} (${r.total} reported, ${r.messages.length} received). Press Refresh to pull again.`);
        }
      }
      return {
        messages: [...sms.messages, ...calls.messages],
        source: 'export',
        note: 'Messages come from GET /conversations/messages/export (SMS and Call channels), which returns the same per-message records as /conversations/{id}/messages in bulk.',
      };
    } catch (err) {
      // A bad token is fatal either way. A missing scope (403) or any other
      // failure falls back to the per-conversation route from the brief.
      if (mode === 'export') throw err;
      if (err instanceof GhlError && err.status === 401) throw err;
      warnings.push(`Bulk message export failed (${err.status || 'network'}: ${err.message}); fell back to walking conversations.`);
    }
  }
  const walked = await ghl.walkConversationMessages(startMs, endMs);
  if (walked.capped) warnings.push(`Conversation walk stopped at ${walked.conversations} conversations; call and SMS counts may be incomplete. Narrow the date range.`);
  return {
    messages: walked.messages,
    source: 'walk',
    note: `Messages come from GET /conversations/search (sorted by last message) followed by GET /conversations/{id}/messages for ${walked.conversations} conversations.`,
  };
}

const TYPE_NAMES = { 1: 'call', 2: 'sms' };

function normalizeMessages(raw) {
  const seen = new Set();
  const out = [];
  for (const m of raw || []) {
    if (!m || !m.id || seen.has(m.id)) continue;
    const mt = String(m.messageType || '').toUpperCase();
    let type = null;
    if (mt === 'TYPE_CALL') type = 'call';
    else if (mt === 'TYPE_SMS') type = 'sms';
    else if (TYPE_NAMES[Number(m.type)]) type = TYPE_NAMES[Number(m.type)];
    if (!type) continue;
    const ms = Date.parse(m.dateAdded);
    if (Number.isNaN(ms)) continue;
    const direction = String(m.direction || '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
    seen.add(m.id);
    out.push({
      id: m.id,
      type,
      direction,
      dateAdded: ms,
      conversationId: m.conversationId || null,
      contactId: m.contactId || null,
      userId: m.userId || null,
      assignedTo: m._assignedTo || null,
      source: m.source || null,
      status: m.status || m.meta?.call?.status || null,
      attributedBy: m.userId ? 'message' : null,
    });
  }
  out.sort((a, b) => a.dateAdded - b.dateAdded);
  return out;
}

/** Credit inbound messages to the teammate who last reached out in that thread. */
function attributeInbound(messages) {
  const byConv = new Map();
  for (const m of messages) {
    if (!m.conversationId) continue;
    if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
    byConv.get(m.conversationId).push(m);
  }
  for (const list of byConv.values()) {
    let lastOut = null;
    for (const m of list) {
      if (m.userId && m.direction === 'outbound') lastOut = m.userId;
      else if (!m.userId && m.direction === 'inbound' && lastOut) {
        m.userId = lastOut;
        m.attributedBy = 'conversation';
      }
    }
    // Second pass: an inbound message that arrived before any outbound in the
    // range takes the next outbound sender in the same thread.
    let nextOut = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.userId && m.direction === 'outbound' && m.attributedBy === 'message') nextOut = m.userId;
      else if (!m.userId && m.direction === 'inbound' && nextOut) {
        m.userId = nextOut;
        m.attributedBy = 'conversation';
      }
    }
  }
  for (const m of messages) {
    if (!m.userId && m.assignedTo) {
      m.userId = m.assignedTo;
      m.attributedBy = 'assigned';
    }
  }
}
