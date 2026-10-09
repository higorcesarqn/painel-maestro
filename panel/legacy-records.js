'use strict';
// legacy-records.js · presents the old model's records (written by bin/registrar.js and bin/pendencia.js,
// with Portuguese field names) with the API's English field names. Removed with the old model in #18.
//
// Only the field names change: the stored values (event types, results, origins, severities, statuses)
// are the old model's own codes and go out as they are. Unknown fields pass through unchanged.

/** Stored event field → API field. */
const EVENT_FIELDS = Object.freeze({
  id: 'id', ts: 'ts', agente: 'agent', fluxo_id: 'flow_id', origem: 'origin', tipo: 'type', projeto: 'project',
  resumo: 'summary', direcao: 'direction', passos: 'steps', comandos: 'commands', alteracoes: 'changes',
  resultado: 'result', validacao: 'validation', proximo_passo: 'next_step', precisa_dono: 'needs_owner',
  pendencias: 'pending_decisions', duracao_s: 'duration_s', sessao: 'session', teste: 'test',
  tipo_original: 'original_type', importado_de: 'imported_from', pedido: 'request', texto: 'text',
});

/** Stored pending decision field → API field. */
const PENDING_DECISION_FIELDS = Object.freeze({
  id: 'id', aberta_em: 'opened_at', agente: 'agent', fluxo_id: 'flow_id', severidade: 'severity', tipo: 'type',
  titulo: 'title', contexto: 'context', opcoes: 'options', recomendacao: 'recommendation', status: 'status',
  resposta: 'answer', respondida_em: 'answered_at', resolvida_em: 'resolved_at', nota: 'note', motivo: 'reason',
  teste: 'test', atualizada_em: 'updated_at',
});

/** Copies a record renaming the known fields (own enumerable keys only; "__proto__" stays a plain key). */
function rename(record, fields) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    const name = Object.prototype.hasOwnProperty.call(fields, k) ? fields[k] : k;
    Object.defineProperty(out, name, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

const eventToApi = (ev) => rename(ev, EVENT_FIELDS);
const pendingDecisionToApi = (p) => rename(p, PENDING_DECISION_FIELDS);

/** The inverse maps (API field → stored field), for test helpers that write old-model files. */
const invert = (fields) => Object.freeze(Object.fromEntries(Object.entries(fields).map(([a, b]) => [b, a])));
const eventFromApi = (ev) => rename(ev, invert(EVENT_FIELDS));
const pendingDecisionFromApi = (p) => rename(p, invert(PENDING_DECISION_FIELDS));

module.exports = { EVENT_FIELDS, PENDING_DECISION_FIELDS, eventToApi, pendingDecisionToApi, eventFromApi, pendingDecisionFromApi };
