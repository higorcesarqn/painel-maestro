'use strict';
// Messages of the bin/ commands of the new model (ADR 0004): the code holds keys, the dictionary holds the texts.
//   t('errors.invalidNumber', { value: 'x' }) → the pt-BR text, with the parameters replaced
// An entry is a text with {param} or a function (params) => text. A missing key comes back as the key itself.
// Adding English is writing another dictionary with the same keys and choosing it here.
const ptBR = require('./pt-BR.js');

const dictionary = ptBR;

function lookup(key) {
  let node = dictionary;
  for (const part of String(key).split('.')) {
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

function t(key, params = {}) {
  const entry = lookup(key);
  if (typeof entry === 'function') return entry(params);
  if (typeof entry !== 'string') return String(key);
  return entry.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name] ?? '') : whole));
}

module.exports = { t, has: (key) => lookup(key) !== undefined };
