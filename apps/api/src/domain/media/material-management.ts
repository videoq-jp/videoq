/** Processing state controls which material operations may be offered. */
export function materialCapabilities(status: string, retryCompleted: boolean, validRetryMessage: boolean) {
  return {
    canEdit: status === 'completed' || status === 'error',
    canReindex: status === 'completed',
    canRetry: status === 'indexing' || (status === 'error' && !retryCompleted && validRetryMessage),
  };
}
