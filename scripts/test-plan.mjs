import assert from 'node:assert/strict';

export const desktopSuites = ['import', 'account', 'playback', 'layout'];
export const desktopScales = [1, 1.25, 1.5];
export const testProtocol = 2;

// Functional checks run once; only geometry depends on the display scale.
export function desktopPlan({ suites = desktopSuites, scales = desktopScales } = {}) {
  suites = [...new Set(suites)];
  scales = [...new Set(scales)];
  assert(suites.length && suites.every(suite => desktopSuites.includes(suite)), 'UNKNOWN_TEST_SUITE');
  assert(scales.length && scales.every(scale => desktopScales.includes(scale)), 'INVALID_TEST_SCALE');
  return suites.flatMap(suite => suite === 'layout'
    ? scales.flatMap((scale, index) => (index === 0 ? ['first', 'resume'] : ['first']).map(phase => ({ suite, scale, phase, functional: index === 0 && phase === 'first' })))
    : ['first', 'resume'].map(phase => ({ suite, scale: 1, phase, functional: false })));
}

export const jobKey = job => `${job.suite}:${job.scale}:${job.phase}`;

export function validateDesktopReport(summary, { mode, after = 0, plan = desktopPlan() } = {}) {
  assert.equal(summary.testProtocol, testProtocol, 'TEST_PROTOCOL_MISMATCH');
  assert.equal(summary.passed, true, 'DESKTOP_TESTS_FAILED');
  if (mode) assert.equal(summary.mode, mode, 'DESKTOP_MODE_MISMATCH');
  assert.deepEqual(summary.reports.map(jobKey), plan.map(jobKey), 'DESKTOP_PLAN_INCOMPLETE_OR_DUPLICATED');
  for (const [index, report] of summary.reports.entries()) {
    assert(report.passed && report.testProtocol === testProtocol, 'INVALID_DESKTOP_RESULT');
    assert.equal(report.functional, plan[index].functional, 'FUNCTIONAL_CHECKS_REPEATED_OR_MISSING');
    assert.equal(report.packaged, summary.mode === 'packaged' || summary.mode === 'installed', 'DESKTOP_BINARY_MODE_MISMATCH');
    assert(Date.parse(report.at) > after, 'DESKTOP_RESULT_STALE');
  }
}
