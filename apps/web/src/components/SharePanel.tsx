import { useEffect, useRef, useState } from 'react';

import { strings } from '../strings';

export function shareUrl(code: string): string {
  return `${location.origin}/room/${code}`;
}

export function SharePanel({ code }: { code: string }) {
  const url = shareUrl(code);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        return;
      }
    } catch {
      // fall through to selecting the text
    }
    input.current?.focus();
    input.current?.select();
  };

  const share = async () => {
    try {
      await navigator.share({ title: strings.appName, url });
    } catch {
      // cancelled or unsupported
    }
  };

  return (
    <section className="panel share-panel" aria-labelledby="share-title">
      <h2 id="share-title" className="panel-title">
        {strings.shareTitle}
      </h2>
      <p className="muted">{strings.shareHelp}</p>
      <input
        ref={input}
        className="input share-url"
        type="text"
        readOnly
        value={url}
        aria-label={strings.shareTitle}
        data-testid="share-url"
        onFocus={(event) => event.target.select()}
      />
      <div className="button-row">
        <button type="button" className="button" onClick={copy}>
          {copied ? strings.copied : strings.copyLink}
        </button>
        {canShare && (
          <button type="button" className="button" onClick={share}>
            {strings.shareLink}
          </button>
        )}
      </div>
    </section>
  );
}
