import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the wallet provider hook used by WalletPicker / auth flow.
const mockSignChallenge = vi.fn();
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

vi.mock('../hooks/useWallet', () => ({
  useWallet: () => ({
    publicKey: 'GABC1234567890',
    connected: true,
    connect: mockConnect,
    disconnect: mockDisconnect,
    signChallenge: mockSignChallenge,
  }),
}));

// Mock the API module. `request` is the low-level client that can throw 401s.
const mockRequest = vi.fn();
const mockAuthenticate = vi.fn();

vi.mock('../api', () => ({
  request: (...args: unknown[]) => mockRequest(...args),
  authenticate: (...args: unknown[]) => mockAuthenticate(...args),
}));

// Mock the auth hook so we can drive session state deterministically.
const mockLogout = vi.fn();
let mockIsAuthenticated = true;

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    logout: mockLogout,
    authenticate: mockAuthenticate,
  }),
}));

// ---------------------------------------------------------------------------
// Components under test (imported after mocks are declared)
// ---------------------------------------------------------------------------

import WalletPicker from './WalletPicker';
import SessionExpiredModal from './SessionExpiredModal';

// A tiny consumer that issues an authenticated API call and renders a form,
// so we can assert that route + unsubmitted form data survive re-auth.
function ProtectedForm() {
  const location = useLocation();
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    try {
      await mockRequest({ method: 'POST', url: '/contracts/build', data: { value } });
      setError(null);
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e?.status === 401) {
        setError('session-expired');
      } else {
        setError('other');
      }
    }
  };

  return (
    <div>
      <span data-testid="route">{location.pathname}</span>
      <input
        aria-label="amount"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button onClick={submit}>Build</button>
      {error && <span data-testid="error">{error}</span>}
    </div>
  );
}

function renderApp(initialPath = '/contracts/new') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <WalletPicker />
      <SessionExpiredModal />
      <Routes>
        <Route path="/contracts/new" element={<ProtectedForm />} />
        <Route path="/" element={<div data-testid="guest-view">Guest</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletPicker session expiration flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAuthenticated = true;
    mockSignChallenge.mockResolvedValue('signed-challenge');
    mockAuthenticate.mockResolvedValue({ token: 'new-jwt' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the SessionExpiredModal when an authenticated API call returns 401', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockRequest.mockRejectedValueOnce(unauthorized);

    renderApp();

    fireEvent.click(screen.getByText('Build'));

    await waitFor(() => {
      expect(screen.getByTestId('error')).toHaveTextContent('session-expired');
    });

    // The modal should be surfaced to the user.
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByText(/session.*expired/i)).toBeInTheDocument();
  });

  it('calls authenticate with { fresh: true } and retries the original request on confirm', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockRequest
      .mockRejectedValueOnce(unauthorized) // first attempt fails
      .mockResolvedValueOnce({ ok: true }); // retry succeeds

    renderApp();

    fireEvent.click(screen.getByText('Build'));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /re-?sign|reconnect|confirm/i }));

    await waitFor(() => {
      expect(mockAuthenticate).toHaveBeenCalledWith({ fresh: true });
    });

    // The original request should be retried automatically.
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    // Modal closes after successful re-auth.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('preserves the current route and unsubmitted form data across re-authentication', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockRequest
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce({ ok: true });

    renderApp('/contracts/new');

    const input = screen.getByLabelText('amount') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '42.5' } });
    expect(input.value).toBe('42.5');

    fireEvent.click(screen.getByText('Build'));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /re-?sign|reconnect|confirm/i }));

    await waitFor(() => {
      expect(mockAuthenticate).toHaveBeenCalledWith({ fresh: true });
    });

    // Route unchanged.
    expect(screen.getByTestId('route')).toHaveTextContent('/contracts/new');
    // Unsubmitted form data preserved.
    expect((screen.getByLabelText('amount') as HTMLInputElement).value).toBe('42.5');
  });

  it('returns to guest view when the modal is dismissed', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockRequest.mockRejectedValueOnce(unauthorized);

    renderApp();

    fireEvent.click(screen.getByText('Build'));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /dismiss|cancel|guest/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Dismissing should log the user out / return to guest view.
    expect(mockLogout).toHaveBeenCalled();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });
});