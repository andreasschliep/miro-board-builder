'use strict';

const { MiroClient, MAX_BOARD_NAME_LENGTH } = require('./miro/client');
const { HttpTransport, DryRunTransport, MiroApiError } = require('./miro/transport');
const { BoardParser } = require('./parser');
const { BoardBuilder } = require('./builder');
const { FrameProtocol } = require('./protocol');
const { validateBoard } = require('./validate');
const { checkBoard, estimateRequiredHeight } = require('./textFit');
const { resolveFrameElements } = require('./frameElements');
const { LayoutAIClient } = require('./ai/layoutClient');
const { LayoutOptimizer } = require('./ai/layoutOptimizer');
const templates = require('./templates');
const style = require('./style');

module.exports = {
  MiroClient,
  MAX_BOARD_NAME_LENGTH,
  HttpTransport,
  DryRunTransport,
  MiroApiError,
  BoardParser,
  BoardBuilder,
  FrameProtocol,
  validateBoard,
  checkBoard,
  estimateRequiredHeight,
  resolveFrameElements,
  LayoutAIClient,
  LayoutOptimizer,
  templates,
  style
};
