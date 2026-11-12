import { Link } from '@/lib/i18n';
import { UtilityLink } from '@/components/ui/utility-link';

interface AuthFormFooterProps {
  questionText: string;
  linkText: string;
  href: string;
}

export function AuthFormFooter({ questionText, linkText, href }: AuthFormFooterProps) {
  return (
    <div className="text-center text-std-17N-170 text-solid-gray-700">
      {questionText}{' '}
      <UtilityLink asChild>
        <Link href={href}>{linkText}</Link>
      </UtilityLink>
    </div>
  );
}
