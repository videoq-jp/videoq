import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import LoginPage from '../LoginPage';
import { useI18nNavigate } from '@/lib/i18n';

vi.mock('@/lib/deployment', () => ({ features: { publicSignup: false, googleLogin: false, emailDelivery: false } }));
vi.mock('@/lib/authSession', () => ({ useAuthSession: () => ({ data: { user: { id: 'signed-in-user' } }, isPending: false }) }));
const completedLogin = vi.hoisted(() => ({ redirect: undefined as (() => void) | undefined }));
vi.mock('@/hooks/useAuthForm', () => ({
  useAuthForm: ({ onSuccessRedirect }: { onSuccessRedirect?: () => void }) => {
    completedLogin.redirect = onSuccessRedirect;
    return { formData: {}, error: null, isLoading: false, handleChange: vi.fn(), handleSubmit: vi.fn() };
  },
}));

beforeEach(() => { vi.clearAllMocks(); completedLogin.redirect = undefined; });

it('resumes the signed-in on-prem user after the login form remounts during a cache replacement', async () => {
  const navigate = useI18nNavigate();
  render(<LoginPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
});

it('keeps one destination when the old login mutation completes after session resumption', async () => {
  const navigate = useI18nNavigate();
  render(<LoginPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith('/'));
  act(() => completedLogin.redirect?.());
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
});

it('does not restart navigation when a session refresh returns the same user in a new object', async () => {
  const navigate = useI18nNavigate();
  const page = render(<LoginPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith('/'));
  page.rerender(<LoginPage />);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
});
