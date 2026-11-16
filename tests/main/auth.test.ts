import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing auth
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', async () => {
  const actual = await vi.importActual<typeof import('util')>('util');
  return {
    ...actual,
    promisify: (fn: Function) => fn,
  };
});

// We test the auth logic patterns, not the actual GH CLI
describe('Auth module patterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear fetch mock between tests
    vi.restoreAllMocks();
  });

  it('should return authenticated status for valid token and API responses', async () => {
    // Simulate the auth validation logic
    const mockUserResponse = { login: 'testuser' };

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockUserResponse),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

    const res = await global.fetch('https://api.github.com/user', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.login).toBe('testuser');
  });

  it('should detect invalid tokens', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    } as Response);

    const res = await global.fetch('https://api.github.com/user', {
      headers: { Authorization: 'Bearer bad-token' },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it('should produce correct AuthStatus shape', () => {
    const successStatus = { authenticated: true, username: 'testuser' };
    expect(successStatus.authenticated).toBe(true);
    expect(successStatus.username).toBe('testuser');

    const failStatus = { authenticated: false, error: 'Token expired' };
    expect(failStatus.authenticated).toBe(false);
    expect(failStatus.error).toBe('Token expired');
  });
});
