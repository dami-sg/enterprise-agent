/**
 * Question rendering + numeric-reply parsing (gateway §6.3).
 */
import { describe, it, expect } from 'vitest';
import { questionPrompt, parseAnswer } from '../src/runtime/interactive.js';
import type { UserQuestion } from '@enterprise-agent/agent-contract';

const single: UserQuestion[] = [
  { question: '选哪个？', header: 'h', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
];
const multiSelect: UserQuestion[] = [
  { question: '可多选', header: 'h', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
];
const twoQuestions: UserQuestion[] = [
  { question: 'q1', header: 'h', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
  { question: 'q2', header: 'h', multiSelect: false, options: [{ label: 'X' }, { label: 'Y' }] },
];

describe('questionPrompt', () => {
  it('numbers the options and adds a hint', () => {
    const p = questionPrompt(single);
    expect(p).toContain('1. A');
    expect(p).toContain('3. C');
    expect(p).toContain('回复选项编号');
  });
});

describe('parseAnswer', () => {
  it('parses a single-select numeric reply', () => {
    expect(parseAnswer(single, '2')).toEqual([{ selected: ['B'] }]);
  });

  it('rejects multiple numbers for a single-select question', () => {
    expect(parseAnswer(single, '1,2')).toBeUndefined();
  });

  it('parses a multi-select reply', () => {
    expect(parseAnswer(multiSelect, '1, 3')).toEqual([{ selected: ['A', 'C'] }]);
  });

  it('parses aligned answers across multiple questions (slash-separated)', () => {
    expect(parseAnswer(twoQuestions, '1/2')).toEqual([{ selected: ['A'] }, { selected: ['Y'] }]);
  });

  it('rejects out-of-range and non-numeric and mismatched-arity replies', () => {
    expect(parseAnswer(single, '4')).toBeUndefined();
    expect(parseAnswer(single, 'B')).toBeUndefined();
    expect(parseAnswer(single, '')).toBeUndefined();
    expect(parseAnswer(twoQuestions, '1')).toBeUndefined();
  });
});
