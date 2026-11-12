import type { KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ChatComposerProps {
  input: string;
  isLoading: boolean;
  onInputChange: (input: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSend: () => Promise<void>;
  onFocus?: () => void;
}

export function ChatComposer({
  input,
  isLoading,
  onInputChange,
  onKeyDown,
  onSend,
  onFocus,
}: ChatComposerProps) {
  const { t } = useTranslation();

  return (
    <div className="shrink-0 border-t border-solid-gray-420 p-3 sm:p-4">
      <div className="relative">
        <Input
          onFocus={onFocus}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isLoading}
          blockSize="lg"
          className="w-full pr-16"
          aria-label={t('chat.placeholder')}
        />
        <Button
          type="button"
          variant="solid"
          size="xs"
          onClick={() => void onSend()}
          disabled={isLoading || !input.trim()}
          className="absolute right-2 top-1/2 h-11 min-w-0 w-11 -translate-y-1/2 px-0"
          aria-label={t('common.actions.send')}
        >
          {isLoading ? <InlineSpinner className="h-4 w-4" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
