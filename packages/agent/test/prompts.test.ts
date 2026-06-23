import { describe, it, expect } from 'vitest';
import {
  ORCHESTRATOR_GUIDANCE,
  TONE_GUIDANCE,
  buildSystemPrompt,
  modeGuidance,
} from '../src/runtime/prompts.js';

describe('TONE_GUIDANCE', () => {
  it('encodes the prose-default / no-bullets-when-refusing / one-question rules', () => {
    expect(TONE_GUIDANCE).toMatch(/Default to prose/);
    // Refusals must stay conversational and never use bullet points.
    expect(TONE_GUIDANCE).toMatch(/never use bullet points to refuse/);
    expect(TONE_GUIDANCE).toMatch(/Ask at most one clarifying question per turn/);
  });
});

describe('ORCHESTRATOR_GUIDANCE', () => {
  it('distinguishes timeless facts from current state and requires tool verification', () => {
    expect(ORCHESTRATOR_GUIDANCE).toMatch(/timeless facts from current state/i);
    expect(ORCHESTRATOR_GUIDANCE).toMatch(/treat it as newer than your cutoff/);
    expect(ORCHESTRATOR_GUIDANCE).toMatch(/getCurrentTime/);
  });

  it('tells the orchestrator to read a covering skill before writing', () => {
    expect(ORCHESTRATOR_GUIDANCE).toMatch(/read that skill first/);
  });

  it('gives a write-to-file vs inline-reply judgement before the truncation warning', () => {
    expect(ORCHESTRATOR_GUIDANCE).toMatch(/Decide where output belongs/);
    expect(ORCHESTRATOR_GUIDANCE).toMatch(/go to a file via writeFile/);
    // The original truncation guidance is preserved.
    expect(ORCHESTRATOR_GUIDANCE).toMatch(/truncated into an invalid call/);
  });
});

describe('buildSystemPrompt', () => {
  it('includes the orchestrator guidance, tone guidance, and goal', () => {
    const prompt = buildSystemPrompt('Ship the feature', '');
    expect(prompt).toContain(ORCHESTRATOR_GUIDANCE);
    expect(prompt).toContain(TONE_GUIDANCE);
    expect(prompt).toContain('Work goal:\nShip the feature');
  });

  it('appends the skill catalog only when non-empty', () => {
    expect(buildSystemPrompt('g', 'CATALOG_XYZ')).toContain('CATALOG_XYZ');
    // Empty catalog leaves no stray catalog section.
    const noCatalog = buildSystemPrompt('g', '');
    expect(noCatalog.endsWith('Work goal:\ng')).toBe(true);
  });
});

describe('modeGuidance', () => {
  it('nudges decisive action in auto mode while forbidding destructive/exfiltrating steps', () => {
    const g = modeGuidance('auto');
    expect(g).toMatch(/AUTO MODE IS ACTIVE/);
    expect(g).toMatch(/data-exfiltrating/);
  });

  it('forces exitPlanMode every turn in plan mode', () => {
    expect(modeGuidance('plan')).toMatch(/PLAN MODE IS ACTIVE/);
    expect(modeGuidance('plan')).toMatch(/calling exitPlanMode/);
  });

  it('adds no nudge in ask mode', () => {
    expect(modeGuidance('ask')).toBe('');
  });
});
