'use strict';

/**
 * Frame templates. A template turns `templateData` from the YAML into a list
 * of elements (offsets from the frame center), so recurring frame layouts are
 * written once.
 *
 * Templates receive (data, board) and use board.colors for their palette.
 */

const { typography, spacing } = require('./style');

/**
 * Titled columns with stacked item cards.
 *
 * templateData:
 *   columns: [{ title, items: [string], color? }]
 *   top: number (optional, y of the column headers, default -200)
 */
function columns(data, board) {
  const { colors } = board;
  const cols = data.columns || [];
  const colWidth = data.columnWidth || 260;
  const gap = spacing.md;
  const startX = -((cols.length - 1) * (colWidth + gap)) / 2;
  const top = data.top !== undefined ? data.top : -200;
  const defaultColors = [colors.primary, colors.secondary, colors.accent, colors.highlight];
  const elements = [];

  cols.forEach((col, i) => {
    const x = startX + i * (colWidth + gap);
    const color = col.color || defaultColors[i % defaultColors.length];
    elements.push({
      type: 'shape',
      content: `<p><strong>${col.title}</strong></p>`,
      x,
      y: top,
      width: colWidth,
      height: 60,
      shape: 'rectangle',
      color,
      borderColor: colors.white,
      textColor: colors.white,
      fontSize: typography.header,
      textAlign: 'center'
    });
    (col.items || []).forEach((item, j) => {
      elements.push({
        type: 'shape',
        content: `<p>${item}</p>`,
        x,
        y: top + 90 + j * 80,
        width: colWidth - 20,
        height: 64,
        shape: 'round_rectangle',
        color: colors.light,
        borderColor: color,
        fontSize: typography.body,
        textAlign: 'center'
      });
    });
  });

  return elements;
}

/**
 * Exercise frame: instructions on the left, numbered debrief questions on the
 * right, an optional transition sentence at the bottom.
 *
 * templateData:
 *   instructions: string (HTML allowed)
 *   timebox: string (optional, e.g. "15 min")
 *   debrief: [string]
 *   transition: string (optional)
 */
function exercise(data, board) {
  const { colors } = board;
  const elements = [];

  if (data.instructions) {
    const heading = data.timebox ? `Instructions (${data.timebox})` : 'Instructions';
    elements.push({
      type: 'shape',
      content: `<p><strong>${heading}</strong></p><p>${data.instructions}</p>`,
      x: -380,
      y: -40,
      width: 560,
      height: 420,
      shape: 'rectangle',
      color: colors.primary,
      borderColor: colors.white,
      textColor: colors.white,
      fontSize: typography.body,
      textAlign: 'left'
    });
  }

  const questions = data.debrief || [];
  if (questions.length > 0) {
    elements.push({
      type: 'shape',
      content: '<p><strong>Debrief</strong></p>',
      x: 360,
      y: -220,
      width: 520,
      height: 60,
      shape: 'rectangle',
      color: colors.accent,
      borderColor: colors.white,
      fontSize: typography.header,
      textAlign: 'center'
    });
    questions.forEach((question, i) => {
      elements.push({
        type: 'shape',
        content: `<p><strong>${i + 1}.</strong> ${question}</p>`,
        x: 360,
        y: -130 + i * 90,
        width: 520,
        height: 76,
        shape: 'round_rectangle',
        color: colors.light,
        borderColor: colors.accent,
        fontSize: typography.body,
        textAlign: 'left'
      });
    });
  }

  if (data.transition) {
    elements.push({
      type: 'text',
      content: `<p><em>Next:</em> ${data.transition}</p>`,
      x: 0,
      y: 330,
      width: 900,
      fontSize: typography.small,
      textAlign: 'center'
    });
  }

  return elements;
}

/**
 * Grid of cards (e.g. takeaways, options, examples).
 *
 * templateData:
 *   cards: [{ title, text?, color? }]
 *   columns: number (default 3)
 *   cardWidth, cardHeight, top (optional)
 */
function cardGrid(data, board) {
  const { colors } = board;
  const cards = data.cards || [];
  const perRow = data.columns || 3;
  const cardWidth = data.cardWidth || 300;
  const cardHeight = data.cardHeight || 160;
  const gapX = cardWidth + spacing.sm;
  const gapY = cardHeight + spacing.sm;
  const startX = -((Math.min(perRow, cards.length) - 1) * gapX) / 2;
  const top = data.top !== undefined ? data.top : -150;

  return cards.map((card, i) => ({
    type: 'shape',
    content: `<p><strong>${card.title}</strong>${card.text ? `</p><p>${card.text}` : ''}</p>`,
    x: startX + (i % perRow) * gapX,
    y: top + Math.floor(i / perRow) * gapY,
    width: cardWidth,
    height: cardHeight,
    shape: 'round_rectangle',
    color: card.color || colors.light,
    borderColor: colors.primary,
    fontSize: typography.body,
    textAlign: 'center'
  }));
}

module.exports = { columns, exercise, cardGrid };
