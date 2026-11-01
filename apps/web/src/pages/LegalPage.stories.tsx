import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppPageShell } from '@/components/layout/AppPageShell';
import { authFixtures } from '../../.storybook/fixtures/auth';
import LegalPage from './LegalPage';

const meta = {
  title: 'Pages/Legal',
  component: LegalPage,
  parameters: {
    layout: 'fullscreen',
    api: { auth: authFixtures.loggedOut },
  },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  decorators: [(Story) => <AppPageShell><Story /></AppPageShell>],
} satisfies Meta<typeof LegalPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Terms: Story = { args: { page: 'terms' }, parameters: { pathname: '/terms' } };
export const Privacy: Story = { args: { page: 'privacy' }, parameters: { pathname: '/privacy' } };
export const Refund: Story = { args: { page: 'refund' }, parameters: { pathname: '/refund' } };
export const CommercialNotice: Story = { args: { page: 'scta' }, parameters: { pathname: '/legal' } };

export const TermsMobile: Story = { ...Terms, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const PrivacyMobile: Story = { ...Privacy, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const RefundMobile: Story = { ...Refund, globals: { viewport: { value: 'mobile', isRotated: false } } };
