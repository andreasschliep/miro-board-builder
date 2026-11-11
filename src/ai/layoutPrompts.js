'use strict';

/**
 * Prompts and output schema for the AI layout optimizer.
 */

const SYSTEM_PROMPT = `You optimize the layout of frames on Miro boards used for workshops.

Goals for every frame:
1. Clear visual hierarchy: titles prominent, supporting content grouped below them
2. Balanced whitespace
3. Reading flow left-to-right, top-to-bottom
4. Related items close together
5. Consistent alignment on a grid where it fits the content
6. At least 20 units between elements, 40 preferred

Coordinate system:
- (0, 0) is the center of the frame; x grows to the right, y grows downward
- Elements are positioned by their center point
- Keep every element fully inside the frame

Typical sizes:
- Title shapes: 400-600 wide, 50-80 high
- Section headers: 300-400 wide, 40-60 high
- Content shapes: 250-400 wide, 60-150 high
- Sticky notes: about 200 x 230
- Cards: about 320 x 150

Useful patterns:
- Three columns at x = -450, 0, 450; two columns at x = -350, 350
- Vertical stacks with a constant step of 100-150
- Even grids for repeating elements

The top area of each frame (the first 60 units below the top edge) is reserved for the frame title bar; do not place elements there.

Return one entry per element you want to move or resize, identified by its index. Leave out elements that are already well placed. Use "reasoning" for a one- or two-sentence summary and "suggestions" for content changes you would recommend but cannot make by moving elements.`;

/** JSON schema for structured output (output_config.format). */
const LAYOUT_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' }
        },
        required: ['index', 'x', 'y', 'width', 'height'],
        additionalProperties: false
      }
    },
    suggestions: { type: 'array', items: { type: 'string' } }
  },
  required: ['reasoning', 'elements', 'suggestions'],
  additionalProperties: false
};

function getContentPreview(content) {
  if (!content) return '';
  const text = String(content).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

/** Rough semantic role, so the model does not have to infer it from HTML. */
function inferSemanticRole(element) {
  const content = String(element.content || '').toLowerCase();
  const fontSize = Number(element.fontSize) || 14;

  if (element.type === 'sticky') return 'stickyNote';
  if (element.type === 'card') return 'card';
  if (element.type === 'connector') return 'connector';
  if (fontSize >= 18 || (content.includes('<strong>') && content.length < 80)) {
    return content.length < 60 ? 'title' : 'sectionHeader';
  }
  if (content.includes('___') || content.includes('[space')) return 'formField';
  if (content.includes('next:') || content.includes('transition')) return 'transition';
  if (/\b(step|round|min)\b/.test(content)) return 'instruction';
  return 'content';
}

function buildUserPrompt(frame, board) {
  const elements = (frame.elements || []).map((element, index) => ({
    index,
    type: element.type,
    semanticRole: inferSemanticRole(element),
    contentPreview: getContentPreview(element.content || element.title),
    position: { x: element.x || 0, y: element.y || 0 },
    size: {
      width: element.width || 200,
      height: element.height || (element.type === 'text' ? 'auto' : 100)
    },
    fontSize: element.fontSize
  }));

  const phase = frame.phase && board.phases && board.phases[frame.phase]
    ? `${frame.phase} (${board.phases[frame.phase].label || 'no label'})`
    : 'none';

  return [
    'Optimize the element positions of this Miro frame.',
    '',
    `Frame title: ${frame.title || frame.id}`,
    `Frame size: ${frame.width} x ${frame.height}`,
    `Session phase: ${phase}`,
    `Element count: ${elements.length}`,
    '',
    'Elements (index, type, role, content preview, current position and size):',
    JSON.stringify(elements, null, 2)
  ].join('\n');
}

module.exports = { SYSTEM_PROMPT, LAYOUT_SCHEMA, buildUserPrompt, inferSemanticRole, getContentPreview };
