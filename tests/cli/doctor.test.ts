import { describe, expect, it } from 'vitest';
import { renderDoctorReport } from '../../src/cli.js';

describe('renderDoctorReport', () => {
  it('reports each probed action as available or blocked', () => {
    const report = renderDoctorReport({
      enabled: new Set(['list', 'tree']),
      probed: { list: true, search: false, tree: true, formatted_content: false },
    });

    expect(report).toMatch(/list.*available/i);
    expect(report).toMatch(/search.*blocked/i);
  });

  it('prints the EXTERNAL_API value to set when something is blocked', () => {
    const report = renderDoctorReport({
      enabled: new Set(['list']),
      probed: { list: true, search: false, tree: true, formatted_content: true },
    });

    expect(report).toContain('EXTERNAL_API');
    expect(report).toContain('"search"');
    expect(report).toContain('formatted_content');
  });

  it('confirms a fully configured instance without printing a fix', () => {
    const report = renderDoctorReport({
      enabled: new Set(['list', 'search', 'tree', 'formatted_content']),
      probed: { list: true, search: true, tree: true, formatted_content: true },
    });

    expect(report).toMatch(/all probed actions are available/i);
    expect(report).not.toContain('EXTERNAL_API');
  });
});
