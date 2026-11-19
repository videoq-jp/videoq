import {
  NotificationBanner,
  NotificationBannerBody,
  type NotificationBannerType,
} from '@/components/ui/notification-banner';

interface MessageAlertProps {
  message: string;
  type: 'error' | 'success' | 'warning';
  role?: 'alert' | 'status';
  className?: string;
}

const typeMap: Record<MessageAlertProps['type'], NotificationBannerType> = {
  error: 'error',
  success: 'success',
  warning: 'warning',
};

export function MessageAlert({ message, type, role = 'alert', className }: MessageAlertProps) {
  return (
    <NotificationBanner
      bannerStyle="standard"
      type={typeMap[type]}
      title={message}
      role={role}
      className={className}
    >
      <NotificationBannerBody />
    </NotificationBanner>
  );
}
