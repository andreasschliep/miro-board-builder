'use strict';

/**
 * Neutral design tokens and the two decorations the builder adds to every
 * frame: a header bar with the frame title and an optional phase badge.
 *
 * All element positions are offsets from the frame center.
 */

const palette = {
  dark: '#1f2937',
  light: '#f3f4f6',
  white: '#ffffff',
  primary: '#2563eb',
  secondary: '#059669',
  accent: '#d97706',
  highlight: '#7c3aed',
  muted: '#6b7280'
};

const typography = {
  frameTitle: 28,
  header: 20,
  body: 14,
  small: 12
};

const headerBar = {
  height: 60,
  color: palette.dark,
  textColor: palette.white,
  fontSize: typography.frameTitle,
  fontFamily: 'open_sans'
};

const spacing = { sm: 40, md: 60, lg: 100 };

function createHeaderBar(title, frameWidth, frameHeight) {
  return {
    type: 'shape',
    content: `<p><strong>${title}</strong></p>`,
    x: 0,
    y: -(frameHeight / 2) + headerBar.height / 2,
    width: frameWidth - 100,
    height: headerBar.height,
    shape: 'rectangle',
    color: headerBar.color,
    borderColor: headerBar.color,
    fontSize: headerBar.fontSize,
    textAlign: 'center',
    textColor: headerBar.textColor,
    fontFamily: headerBar.fontFamily,
    _decoration: 'header'
  };
}

/**
 * Small circle in the top-left corner, below the header bar.
 * @param {string} key - Phase key as used in the YAML (e.g. "C2")
 * @param {Object} phase - Phase definition ({ label, color })
 */
function createPhaseBadge(key, phase, frameWidth, frameHeight) {
  const size = 60;
  return {
    type: 'shape',
    content: `<p><strong>${key}</strong></p>`,
    x: -(frameWidth / 2) + 70,
    y: -(frameHeight / 2) + headerBar.height + 50,
    width: size,
    height: size,
    shape: 'circle',
    color: phase.color || palette.muted,
    borderColor: palette.white,
    fontSize: 16,
    textAlign: 'center',
    _decoration: 'phase'
  };
}

module.exports = { palette, typography, headerBar, spacing, createHeaderBar, createPhaseBadge };
