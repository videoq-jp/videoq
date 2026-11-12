import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/digital-agency/cn';
import { Divider } from '@/components/ui/divider';
import { Heading, HeadingTitle } from '@/components/ui/heading';

type DashboardPanelProps = ComponentProps<'section'>;

export function DashboardPanel({ className, ...props }: DashboardPanelProps) {
  return (
    <section
      className={cn('space-y-3 border-t border-solid-gray-420 pt-4', className)}
      {...props}
    />
  );
}

export function DashboardChartTitle({ children }: { children: ReactNode }) {
  return (
    <>
      <Heading size="20">
        <HeadingTitle level="h3">{children}</HeadingTitle>
      </Heading>
      <Divider />
    </>
  );
}
