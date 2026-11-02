import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ViewerActionsMenu } from '../ViewerActionsMenu';

function Example({ onAction = () => {} }: { onAction?: () => void }) {
  return <><ViewerActionsMenu label="Course actions"><button onClick={onAction}>Share</button><button>Edit</button></ViewerActionsMenu><button>Outside</button></>;
}

it('opens with the shared button and returns focus after Escape', async () => {
  render(<Example />);
  const trigger = screen.getByRole('button', { name: 'Course actions' });
  expect(trigger).toHaveAttribute('data-slot', 'button');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toHaveFocus());
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
});

it('closes on an outside pointer without stealing focus from its target', async () => {
  const user = userEvent.setup();
  render(<Example />);
  const trigger = screen.getByRole('button', { name: 'Course actions' });
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'Outside' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
});

it('restores focus before invoking an action so a dialog can return to the trigger', async () => {
  const user = userEvent.setup();
  const action = vi.fn(() => expect(screen.getByRole('button', { name: 'Course actions' })).toHaveFocus());
  render(<Example onAction={action} />);
  await user.click(screen.getByRole('button', { name: 'Course actions' }));
  await user.click(screen.getByRole('button', { name: 'Share' }));
  expect(action).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Course actions' })).toHaveAttribute('aria-expanded', 'false');
});

it('lets Tab leave the list without trapping focus or leaving it open', async () => {
  const user = userEvent.setup();
  render(<Example />);
  const trigger = screen.getByRole('button', { name: 'Course actions' });
  await user.click(trigger);
  await user.tab();
  expect(screen.getByRole('button', { name: 'Share' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
