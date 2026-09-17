import { useTranslation } from 'react-i18next';

interface LoadMoreMessagesBarProps {
  shown: number;
  total: number;
  isLoading: boolean;
  onLoadMore: () => void;
  onLoadAll: () => void;
}

/**
 * Header bar for a paginated conversation. Scrolling to the top still loads the
 * next page, but a pointer is not always available to do it: a desktop browser
 * with no wheel or trackpad, a kiosk display, or a keyboard-only session can
 * never reach the top, so the same two actions are spelled out as buttons.
 */
export default function LoadMoreMessagesBar({
  shown,
  total,
  isLoading,
  onLoadMore,
  onLoadAll,
}: LoadMoreMessagesBarProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
      <span>{t('session.messages.showingOf', { shown, total })}</span>{' '}
      <button
        type="button"
        onClick={onLoadMore}
        disabled={isLoading}
        className="text-blue-600 underline hover:text-blue-700 disabled:cursor-wait disabled:no-underline disabled:opacity-60 dark:text-blue-400 dark:hover:text-blue-300"
      >
        {t('session.messages.loadEarlier')}
      </button>
      <span className="px-1 text-gray-300 dark:text-gray-600" aria-hidden="true">·</span>
      <button
        type="button"
        onClick={onLoadAll}
        disabled={isLoading}
        className="text-blue-600 underline hover:text-blue-700 disabled:cursor-wait disabled:no-underline disabled:opacity-60 dark:text-blue-400 dark:hover:text-blue-300"
      >
        {t('session.messages.loadAll')}
      </button>
    </div>
  );
}
