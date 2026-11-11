'use strict';

/**
 * Resolve the complete element list of a frame: header bar, template or
 * explicit elements, phase badge. Pure function, shared by the builder, the
 * text-fit check and the dry run so they all see the same content.
 */

const { createHeaderBar, createPhaseBadge } = require('./style');
const defaultTemplates = require('./templates');

function resolveFrameElements(frame, board, templates = defaultTemplates) {
  const elements = [];

  if (board.style && board.style.headerBar !== false && frame.headerBar !== false) {
    elements.push(createHeaderBar(frame.title, frame.width, frame.height));
  }

  if (frame.template) {
    const template = templates[frame.template];
    if (!template) throw new Error(`Frame '${frame.id}': unknown template '${frame.template}'`);
    elements.push(...template(frame.templateData || {}, board));
  }

  if (frame.elements) {
    elements.push(...frame.elements);
  }

  if (frame.phase && board.phases && board.phases[frame.phase]) {
    elements.push(createPhaseBadge(frame.phase, board.phases[frame.phase], frame.width, frame.height));
  }

  return elements;
}

module.exports = { resolveFrameElements };
