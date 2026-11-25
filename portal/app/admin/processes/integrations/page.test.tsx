import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IntegrationManagementPage from './page';
import { completeDeploymentInvocation, getIntegrations, getInvocations, type Invocation } from '../../../lib/integrations';

vi.mock('../../../lib/integrations', () => ({
  completeDeploymentInvocation: vi.fn(),
  getIntegrations: vi.fn(),
  getInvocations: vi.fn(),
  retryInvocation: vi.fn(),
  saveIntegration: vi.fn(),
}));

it('triggers only the eligible deployment row using the URL entered in the dialog', async () => {
  const deploy: Invocation = {
    id: 'deploy-id', nodeKey: '部署', instanceId: 'workflow-id', serviceCode: 'deployment',
    operation: 'deploy.submit.v1', status: 'Sent', attempts: 1, expiresAt: '2026-11-21T00:00:00Z',
    canTriggerDeployment: true,
  };
  const audit: Invocation = { ...deploy, id: 'audit-id', nodeKey: '审核', serviceCode: 'code-audit', canTriggerDeployment: false };
  vi.mocked(getIntegrations).mockResolvedValue([]);
  vi.mocked(getInvocations)
    .mockResolvedValueOnce({ items: [deploy, audit], total: 2 })
    .mockResolvedValue({ items: [{ ...deploy, status: 'Completed', canTriggerDeployment: false }, audit], total: 2 });
  vi.mocked(completeDeploymentInvocation).mockResolvedValue({ duplicate: false });

  const user = userEvent.setup();
  render(<IntegrationManagementPage />);
  await user.click(await screen.findByRole('button', { name: '触发部署回调' }));
  const dialog = within(screen.getByRole('dialog', { name: '触发部署回调' }));
  expect(dialog.getByRole('button', { name: '确认触发' })).toBeDisabled();
  await user.type(dialog.getByRole('textbox', { name: '部署地址' }), 'https://app.example:8132/');
  await user.click(dialog.getByRole('button', { name: '确认触发' }));

  expect(completeDeploymentInvocation).toHaveBeenCalledWith('deploy-id', 'https://app.example:8132/');
  expect(await screen.findByText('部署回调已处理，流程已继续')).toBeVisible();
  expect(await screen.findByText('Completed')).toBeVisible();
  await waitFor(() => expect(screen.queryByRole('button', { name: '触发部署回调' })).not.toBeInTheDocument());
});
