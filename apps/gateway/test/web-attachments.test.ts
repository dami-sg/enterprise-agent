/**
 * Multimodal attachment parsing (web-app §4 / multimodal §6): AI SDK `file`
 * parts (browser uploads → base64 data URLs) → agent UserParts. Images become
 * `image` parts, other types `file` parts; remote URLs (non-data) are skipped.
 */
import { describe, it, expect } from 'vitest';
import { toUserParts } from '../src/web/chat-endpoint.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANS';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

it('maps an image data URL to an image UserPart', () => {
  expect(toUserParts([{ type: 'file', mediaType: 'image/png', url: PNG, filename: 'a.png' }])).toEqual([
    { type: 'image', data: 'iVBORw0KGgoAAAANS', mediaType: 'image/png' },
  ]);
});

it('maps a non-image data URL to a file UserPart (keeps filename)', () => {
  expect(toUserParts([{ type: 'file', mediaType: 'application/pdf', url: PDF, filename: 'doc.pdf' }])).toEqual([
    { type: 'file', data: 'JVBERi0xLjQK', mediaType: 'application/pdf', filename: 'doc.pdf' },
  ]);
});

it('derives mediaType from the data URL when not provided', () => {
  expect(toUserParts([{ type: 'file', url: PNG }])).toEqual([
    { type: 'image', data: 'iVBORw0KGgoAAAANS', mediaType: 'image/png' },
  ]);
});

it('skips text parts and remote (non-data) URLs', () => {
  expect(
    toUserParts([
      { type: 'text' },
      { type: 'file', mediaType: 'image/png', url: 'https://example.com/x.png' },
    ]),
  ).toEqual([]);
});

it('reads from `data` when there is no `url`', () => {
  expect(toUserParts([{ type: 'file', data: PNG }])).toEqual([
    { type: 'image', data: 'iVBORw0KGgoAAAANS', mediaType: 'image/png' },
  ]);
});
