import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api/api-error';
import { ApiErrorAlert } from './ApiErrorAlert.js';

describe('ApiErrorAlert', () => {
  it('shows accessible German error text and a safe reference ID', () => {
    const html = renderToStaticMarkup(
      <ApiErrorAlert error={new ApiError('http', 409, 'PLAN_CONCURRENT_MODIFICATION', 'request-123')} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Plan wurde inzwischen geändert');
    expect(html).toContain('Referenz-ID:');
    expect(html).toContain('request-123');
  });

  it('does not show unsafe Error.message or arbitrary raw server detail', () => {
    const html = renderToStaticMarkup(<ApiErrorAlert error={new Error('password=secret-123')} />);
    expect(html).not.toContain('secret-123');
    expect(html).toContain('Ein Fehler ist aufgetreten');
  });

  it('does not render an empty error state', () => {
    expect(renderToStaticMarkup(<ApiErrorAlert error={null} />)).toBe('');
  });
});
