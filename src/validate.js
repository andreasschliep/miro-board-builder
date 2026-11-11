'use strict';

/**
 * Validation of a board definition:
 * 1. JSON Schema (schema/board.schema.json) on the raw YAML
 * 2. Semantic checks the schema cannot express (unique ids, connector refs,
 *    known templates and phases)
 * 3. Text-fit warnings for shapes whose text will overflow
 */

const Ajv = require('ajv');
const schema = require('../schema/board.schema.json');
const defaultTemplates = require('./templates');
const { checkBoard } = require('./textFit');

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

function schemaErrors(raw) {
  if (validateSchema(raw)) return [];
  return validateSchema.errors.map((error) => {
    const where = error.instancePath || '(root)';
    return `${where} ${error.message}`;
  });
}

function collectRefs(elements, refs, duplicates) {
  for (const element of elements || []) {
    if (element.ref) {
      if (refs.has(element.ref)) duplicates.add(element.ref);
      refs.add(element.ref);
    }
    if (element.items) collectRefs(element.items, refs, duplicates);
  }
}

function collectConnectors(elements, out) {
  for (const element of elements || []) {
    if (element.type === 'connector') out.push(element);
    if (element.items) collectConnectors(element.items, out);
  }
}

/**
 * @param {Object} raw - YAML as loaded (no defaults applied)
 * @param {Object} board - Normalized board (BoardParser.normalize)
 * @param {Object} [templates]
 * @returns {{ valid: boolean, errors: string[], warnings: string[], textFit: Object[] }}
 */
function validateBoard(raw, board, templates = defaultTemplates) {
  const errors = schemaErrors(raw);
  const warnings = [];

  if (errors.length > 0) {
    return { valid: false, errors, warnings, textFit: [] };
  }

  const frameIds = new Set();
  const refs = new Set();
  const duplicateRefs = new Set();
  const connectors = [];

  for (const frame of board.frames) {
    if (frameIds.has(frame.id)) errors.push(`Duplicate frame id: ${frame.id}`);
    frameIds.add(frame.id);

    if (frame.template && !templates[frame.template]) {
      errors.push(`Frame '${frame.id}': unknown template '${frame.template}' (available: ${Object.keys(templates).join(', ')})`);
    }
    if (frame.phase && !board.phases[frame.phase]) {
      warnings.push(`Frame '${frame.id}': phase '${frame.phase}' is not defined under 'phases' (no badge will be drawn)`);
    }
    collectRefs(frame.elements, refs, duplicateRefs);
    collectConnectors(frame.elements, connectors);
  }

  for (const ref of duplicateRefs) errors.push(`Duplicate element ref: ${ref}`);

  for (const connector of connectors) {
    if (!connector.from || !connector.to) {
      errors.push('Connector needs both `from` and `to`');
      continue;
    }
    if (!refs.has(connector.from)) errors.push(`Connector source ref '${connector.from}' does not exist`);
    if (!refs.has(connector.to)) errors.push(`Connector target ref '${connector.to}' does not exist`);
  }

  let textFit = [];
  if (errors.length === 0) {
    textFit = checkBoard(board, templates);
  }

  return { valid: errors.length === 0, errors, warnings, textFit };
}

module.exports = { validateBoard, schemaErrors };
